/**
 * Request-body construction and VS Code → OpenAI message mapping.
 *
 * Maps the VS Code request onto the endpoint's OpenAI-compatible
 * `POST /chat/completions` payload, and maps each VS Code request message into
 * one or more OpenAI messages (tool results split out into `role: tool`
 * entries, images into their own `user` message).
 */
import * as vscode from 'vscode';
import {
  THINKING_DISABLE_STYLE,
  UTILITY_MAX_OUTPUT_TOKENS,
  thinkingEffortParam,
  type ModelEntry,
  type ThinkingEffort,
} from './config';
import { type RequestKind, type UtilityDowngrade, utilityDowngrade } from './requestKind';
import { readReasoningMarker } from './replay';
import { isThinkingPart, thinkingPartText } from './thinking';

export type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  /**
   * Reasoning text from a previous round, sent back so a thinking model keeps
   * its chain of thought (a common vendor convention). Only ever present
   * when THIS provider produced the thinking part in the first place, and
   * stripped automatically if the gateway rejects it with a 400.
   */
  reasoning_content?: string;
};

/**
 * Request options widened with the non-public per-model configuration fields:
 * the gear-panel choice the user made for this model comes back request-scoped
 * under `modelOptions` (newer hosts), `modelConfiguration` or `configuration`
 * — the same contract the official Auto selector and the built-in
 * reasoning-effort dropdown ride on. Absent on older hosts: the default
 * applies.
 */
type ConfiguredRequestOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelOptions?: Record<string, unknown>;
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

/** The thinking effort the user picked for this request, or `undefined`. */
export function readThinkingEffortChoice(
  options: vscode.ProvideLanguageModelChatResponseOptions
): string | undefined {
  const widened = options as ConfiguredRequestOptions;
  for (const source of [widened.modelOptions, widened.modelConfiguration, widened.configuration]) {
    const value = source?.reasoningEffort;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * The first READABLE number the host handed down for ONE configuration key.
 * Sources are tried in order and an unreadable value falls through to the next
 * one — a host that sends a stale string in `modelOptions` must not hide the
 * real number in `modelConfiguration`.
 */
function configuredNumber(
  options: vscode.ProvideLanguageModelChatResponseOptions,
  key: string
): number | undefined {
  const widened = options as ConfiguredRequestOptions;
  for (const source of [widened.modelOptions, widened.modelConfiguration, widened.configuration]) {
    const value = source?.[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

/**
 * The limit overrides the model's configuration panel sent for THIS request,
 * read back through the same three request-scoped sources as the gear choice.
 *
 * Two spellings mean the same thing for the input budget:
 *   - `contextSize` — the context-window dropdown (host group `tokens`);
 *   - `maxInputTokens` — a host handing the raw field name down.
 * They collapse into ONE field (`maxInputTokens`) so the store never holds two
 * disagreeing numbers; the dropdown wins when both arrive.
 *
 * Per field: `undefined` = the panel did not send it this request ·
 * `> 0` = a custom value to apply (and persist) · `<= 0` = cleared — restore
 * the default limits.
 */
export function readModelLimitOverrides(
  options: vscode.ProvideLanguageModelChatResponseOptions
): { maxInputTokens?: number; maxOutputTokens?: number } {
  const overrides: { maxInputTokens?: number; maxOutputTokens?: number } = {};
  for (const field of ['maxInputTokens', 'maxOutputTokens'] as const) {
    const numeric = configuredNumber(options, field);
    if (numeric !== undefined) {
      overrides[field] = numeric;
    }
  }
  const window = configuredNumber(options, 'contextSize');
  if (window !== undefined) {
    overrides.maxInputTokens = window;
  }
  return overrides;
}

/**
 * Apply panel overrides onto an entry for THIS request. `> 0` replaces the
 * field; anything else keeps the resolved value (clearing is handled by the
 * persist path, which deletes the stored field — the resolved value already
 * IS the default then).
 */
export function applyLimitOverrides<T extends { maxInputTokens: number; maxOutputTokens: number }>(
  entry: T,
  overrides: { maxInputTokens?: number; maxOutputTokens?: number }
): T {
  return {
    ...entry,
    ...(overrides.maxInputTokens !== undefined && overrides.maxInputTokens > 0
      ? { maxInputTokens: Math.floor(overrides.maxInputTokens) }
      : {}),
    ...(overrides.maxOutputTokens !== undefined && overrides.maxOutputTokens > 0
      ? { maxOutputTokens: Math.floor(overrides.maxOutputTokens) }
      : {}),
  };
}

/**
 * Map the VS Code request onto the endpoint's OpenAI-compatible
 * `POST /chat/completions` payload. Streaming is always requested — the
 * chat UI renders incrementally from the progress callbacks.
 *
 * `requestKind` drives the utility downgrade (see requestKind.ts): helper
 * classes lose their tool list and get a bounded `max_tokens`; no
 * thinking-disable parameter is ever sent (there is no cross-vendor spelling
 * for "do not think" — see THINKING_DISABLE_STYLE in config.ts).
 *
 * The thinking-effort gear (the model picker's per-model dropdown) rides out
 * as `reasoning_effort` — `auto` sends nothing at all. Helper requests never
 * carry it: a chat title must not spend the user's key on chain-of-thought.
 *
 * Any parameter this function changes for compatibility reasons is described
 * in `notes`, so the request log shows WHY a payload differs from the plain
 * one.
 */
export function buildRequestBody(
  entry: ModelEntry,
  effort: ThinkingEffort,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  requestKind: RequestKind,
  /** Collected one-line remarks (empty = payload is exactly as requested). */
  notes: string[] = []
): Record<string, unknown> {
  const mapped: OpenAiMessage[] = [];
  for (const message of messages) {
    mapped.push(...convertMessage(message));
  }

  const policy = resolveUtilityPolicy(requestKind);

  const tools =
    !policy?.stripTools && options.tools?.length
      ? options.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema ?? {},
          },
        }))
      : undefined;

  const toolChoice = tools
    ? options.toolMode === vscode.LanguageModelChatToolMode.Required
      ? 'required'
      : options.toolMode === vscode.LanguageModelChatToolMode.Auto
        ? 'auto'
        : undefined
    : undefined;

  const body: Record<string, unknown> = {
    model: entry.id,
    messages: mapped,
    stream: true,
    // Ask for the final usage-only SSE chunk (OpenAI stream_options). Gateways
    // that reject the parameter get a 400-retry without it (see request path).
    stream_options: { include_usage: true },
  };
  if (tools) {
    body.tools = tools;
  }
  if (toolChoice) {
    body.tool_choice = toolChoice;
  }
  // A helper request answers in a sentence; without this it may generate up to
  // the model's full output ceiling on every chat title and commit message.
  if (policy?.maxOutputTokens !== undefined) {
    body.max_tokens = policy.maxOutputTokens;
  }
  // The gear-panel choice (see readThinkingEffortChoice) — `auto` sends
  // nothing, every other value is passed through verbatim. Helper requests are
  // skipped: a title generator has no use for chain-of-thought, and
  // `reasoning_effort` on a bounded-`max_tokens` helper would spend the whole
  // budget on reasoning before the answer.
  const effortParam = policy?.disableThinking ? undefined : thinkingEffortParam(effort);
  if (effortParam) {
    body.reasoning_effort = effortParam;
  }
  // Helper requests ask for no reasoning: thinking is ON by default upstream
  // and a 2K `max_tokens` would then be spent on reasoning tokens first.
  // THINKING_DISABLE_STYLE is fixed at 'none': a wrong-vendor
  // "do not think" parameter costs a round-trip, so none is sent.
  const thinkingOff = policy?.disableThinking === true ? thinkingDisablePayload() : undefined;
  if (thinkingOff) {
    Object.assign(body, thinkingOff);
  } else if (policy?.disableThinking === true) {
    // Worth a log line: the helper still reasons, so its `max_tokens` has to
    // cover reasoning AND the answer.
    notes.push('thinking stays ON for this helper (no thinking-disable parameter configured)');
  }
  return body;
}

/**
 * The "do not think" parameters for the configured style, or `undefined`.
 * The style is FIXED (`none`): no parameter is sent. The switch stays so a
 * future style can be added in one place.
 */
function thinkingDisablePayload(): Record<string, unknown> | undefined {
  switch (THINKING_DISABLE_STYLE) {
    case 'thinking-disabled':
      return { thinking: { type: 'disabled' } };
    case 'chat_template_kwargs':
      return { chat_template_kwargs: { thinking: false } };
    case 'enable_thinking':
      return { enable_thinking: false };
    case 'openai':
      // `low` is the lowest effort most gateways accept; `minimal` is rejected
      // outright and thinking stays on either way.
      return { reasoning_effort: 'low' };
    case 'none':
    default:
      return undefined;
  }
}

/**
 * The downgrade for this request — ALWAYS on (no kill switch): helper classes
 * get their tools stripped and a bounded `max_tokens`.
 */
function resolveUtilityPolicy(requestKind: RequestKind): UtilityDowngrade {
  return utilityDowngrade(requestKind, UTILITY_MAX_OUTPUT_TOKENS);
}

/**
 * Parameters this provider adds on top of the bare OpenAI chat-completion
 * shape. Every one is optional, so any of them may be dropped on a 400.
 *
 * `tool_choice` is last on purpose: dropping it leaves OpenAI's default (`auto`
 * when tools are present), which keeps a forced call working as a best-effort
 * call. Some gateways reject `required` / a named tool in thinking mode.
 */
const OPTIONAL_BODY_PARAMS = [
  'stream_options',
  'max_tokens',
  'thinking',
  'chat_template_kwargs',
  'enable_thinking',
  'reasoning_effort',
  'tool_choice',
] as const;

/**
 * Strip whichever optional parameters the gateway's error body names.
 * Returns what was removed (empty = the 400 was about something else).
 */
export function dropRejectedParams(body: Record<string, unknown>, detail: string): string[] {
  const dropped: string[] = [];
  for (const param of OPTIONAL_BODY_PARAMS) {
    if (param in body && new RegExp(param, 'i').test(detail)) {
      delete body[param];
      dropped.push(param);
    }
  }
  // `reasoning_content` lives inside the messages, not at the top level.
  //
  // Strip it ONLY when the request carries no `tools`: some gateways
  // REQUIRE every earlier turn's reasoning_content to be replayed once tools
  // are present (omitting it is itself a 400), so stripping there would trade
  // one failure for another. Without tools the field is ignored upstream and
  // rejected only by strict-schema gateways — exactly the case worth healing.
  if (!('tools' in body) && /reasoning_content/i.test(detail) && Array.isArray(body.messages)) {
    let removed = false;
    for (const message of body.messages as OpenAiMessage[]) {
      if (message.reasoning_content !== undefined) {
        delete message.reasoning_content;
        removed = true;
      }
    }
    if (removed) {
      dropped.push('reasoning_content');
    }
  }
  return dropped;
}

/**
 * How far the 400-recovery ladder may go. Each level is one RETRY of the same
 * request with strictly less "extra" surface than the level before it.
 */
export const MAX_COMPATIBILITY_LEVEL = 4;

/**
 * Progressive HTTP-400 recovery.
 *
 * A gateway that rejects a body answers with something generic — one common
 * front-end replies `"the request was rejected by an internal gateway
 * component … please check the request body"` and never names the offending
 * field. Matching field names against that text (see dropRejectedParams)
 * therefore never fires, and the user is left with a hard failure on every
 * round after the first.
 *
 * So the fallback is a LADDER instead of a parse: each level removes one more
 * class of optional surface and the caller retries. Levels are cumulative —
 * the same body object is mutated, so level 3 also carries the removals of
 * level 2.
 *
 *   1  whatever the error text names (the original, precise behaviour)
 *   2  `reasoning_content` replay + `stream_options`
 *   3  `max_tokens`, the thinking switches and `tool_choice`; empty messages
 *   4  `tools` entirely — a text-only answer beats no answer at all
 *
 * Returns what this level removed; an EMPTY list means the ladder is
 * exhausted (nothing left that this level could take away) and the caller
 * should surface the error instead of retrying.
 */
export function applyCompatibilityFallback(
  body: Record<string, unknown>,
  level: number,
  detail: string
): string[] {
  const removed: string[] = [];
  // Level 1 (and every level after it) also honours a gateway that DOES name
  // the parameter — that is a precise signal, never worth ignoring.
  removed.push(...dropRejectedParams(body, detail));

  if (level >= 2) {
    // Thinking replay: the previous round's chain of thought is re-attached to
    // its assistant message as `reasoning_content`. Some gateways want it
    // back; a gateway that does not model the field rejects the body. This
    // is the single most common "first round works, second round 400s"
    // trigger on a thinking model, and it must be strippable even when
    // `tools` are present (the precise path above deliberately skips that
    // case, so an unnamed rejection could never recover).
    if (stripReasoningContent(body)) {
      removed.push('reasoning_content');
    }
    if ('stream_options' in body) {
      delete body.stream_options;
      removed.push('stream_options');
    }
  }

  if (level >= 3) {
    for (const param of [
      'max_tokens',
      'thinking',
      'chat_template_kwargs',
      'enable_thinking',
      'reasoning_effort',
      'tool_choice',
    ] as const) {
      if (param in body) {
        delete body[param];
        removed.push(param);
      }
    }
    if (dropEmptyMessages(body)) {
      removed.push('empty messages');
    }
  }

  if (level >= 4 && 'tools' in body) {
    delete body.tools;
    if ('tool_choice' in body) {
      delete body.tool_choice;
    }
    removed.push('tools');
  }
  return removed;
}

/** Remove the replayed reasoning from every message. Returns whether anything went. */
function stripReasoningContent(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) {
    return false;
  }
  let removed = false;
  for (const message of body.messages as OpenAiMessage[]) {
    if (message.reasoning_content !== undefined) {
      delete message.reasoning_content;
      removed = true;
    }
  }
  return removed;
}

/**
 * Drop messages that carry nothing a gateway can validate: `content: ""` (or
 * `null`) with no `tool_calls`. Never touches a tool-call or tool-result
 * message — removing those would orphan the pairing this file works hard to
 * keep intact.
 */
function dropEmptyMessages(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) {
    return false;
  }
  const messages = body.messages as OpenAiMessage[];
  const kept = messages.filter((message) => {
    if (message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0) {
      return true;
    }
    if (message.content === null || message.content === undefined || message.content === '') {
      return false;
    }
    return true;
  });
  if (kept.length === messages.length) {
    return false;
  }
  body.messages = kept;
  return true;
}

/**
 * A one-line, content-free digest of the message array — the diagnostic that
 * answers "which shape did the gateway actually reject" without logging a
 * single word of the prompt:
 *
 *   `3[system,user,assistant(tools:2,think)]`
 *
 * `empty` marks a message the gateway could reject for carrying no content.
 */
export function bodyDigest(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as OpenAiMessage[]) : [];
  const parts = messages.map((message) => {
    const marks: string[] = [];
    if (message.content === '' || message.content === null || message.content === undefined) {
      marks.push('empty');
    }
    if ((message.tool_calls?.length ?? 0) > 0) {
      marks.push(`tools:${message.tool_calls?.length}`);
    }
    if (message.reasoning_content !== undefined) {
      marks.push('think');
    }
    if (message.tool_call_id) {
      marks.push('result');
    }
    return marks.length > 0 ? `${message.role}(${marks.join(',')})` : message.role;
  });
  return `${messages.length}[${parts.join(',')}]`;
}

/**
 * One VS Code request message → one or more OpenAI messages. Tool-result
 * parts arrive inside USER messages and must be split out into `role: tool`
 * entries for the OpenAI wire format; text and images stay in the message
 * they belong to.
 */export function convertMessage(message: vscode.LanguageModelChatRequestMessage): OpenAiMessage[] {
  const role: OpenAiMessage['role'] =
    message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';

  const textChunks: string[] = [];
  const thinkingChunks: string[] = [];
  const images: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  const toolResults: OpenAiMessage[] = [];
  const toolResultImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  const assistantToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      textChunks.push(part.value);
    } else if (isThinkingPart(part)) {
      // Reasoning we streamed on an earlier round — hand it back so the model
      // keeps its chain of thought instead of restarting it.
      thinkingChunks.push(thinkingPartText(part));
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push({
        role: 'tool',
        tool_call_id: part.callId,
        content: stringifyToolResult(part.content),
      });
      // A tool can return an image. An OpenAI-compatible `tool` message is
      // text-only, so the image is forwarded as a follow-up user message —
      // the same shape the host uses for images the user attaches.
      for (const image of imageDataParts(part.content)) {
        const dataUrl = dataPartToDataUrl(image);
        if (dataUrl) {
          toolResultImages.push({ type: 'image_url', image_url: { url: dataUrl } });
        }
      }
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      assistantToolCalls.push({
        id: part.callId,
        type: 'function',
        function: { name: part.name, arguments: safeJsonStringify(part.input) },
      });
    } else if (isDataPart(part)) {
      const dataUrl = dataPartToDataUrl(part);
      if (dataUrl) {
        images.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }
  }

  const text = textChunks.join('');
  const out: OpenAiMessage[] = [];
  if (role === 'assistant') {
    const assistantMessage: OpenAiMessage = {
      role: 'assistant',
      // `''`, not `null`: a strict validator treats a null content as a
      // malformed body even when `tool_calls` is present, and every tool round
      // produces exactly that shape.
      content: text || '',
    };
    if (assistantToolCalls.length > 0) {
      assistantMessage.tool_calls = assistantToolCalls;
    }
    // Replay source precedence: our own marker (exact text the gateway
    // produced last turn, replayed by the host as an opaque data part) beats
    // thinking parts (present only when the host kept them, and absent after
    // a reload). See replay.ts for why the reasoning must be handed back.
    const replayedReasoning = readReasoningMarker(message.content);
    const reasoning = replayedReasoning ?? (thinkingChunks.length > 0 ? thinkingChunks.join('') : undefined);
    if (reasoning) {
      assistantMessage.reasoning_content = reasoning;
    }
    // A turn that carries nothing at all (no text, no call, no reasoning —
    // e.g. a control-flow round the host kept an empty shell for) is NOT a
    // legal OpenAI message: `{role:'assistant',content:''}` without
    // `tool_calls` fails body validation on strict gateways. Drop it.
    if (text.length > 0 || assistantToolCalls.length > 0 || reasoning) {
      out.push(assistantMessage);
    }
  } else {
    // ORDER IS PART OF THE CONTRACT: an OpenAI `tool` message must come
    // DIRECTLY after the assistant message whose `tool_calls` it answers.
    //
    // VS Code hands a tool result to us inside a USER message, so the previous
    // shape was `assistant(tool_calls)` → `user("")` → `tool(...)`: an EMPTY
    // user turn wedged into the call/result pair. Lenient gateways ignore the
    // empty turn; strict ones reject the whole body with a generic HTTP 400 —
    // which is exactly why a conversation can answer the first prompt and then
    // fail on the second round. Tool results therefore go out FIRST, and the
    // user's own text (if this message carries any) follows them.
    out.push(...toolResults);
    if (images.length > 0) {
      out.push({
        role: 'user',
        content: [{ type: 'text', text }, ...images],
      });
    } else if (text.length > 0) {
      out.push({ role: 'user', content: text });
    }
    // Nothing to say and no image? Emit no user message rather than an empty
    // one — an empty `content` is itself a rejection reason on some gateways.
  }
  if (toolResultImages.length > 0) {
    out.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_IMAGE_CAPTION }, ...toolResultImages],
    });
  }
  return out;
}

/**
 * Caption for images that came out of a tool result — they travel in their own
 * user message, so the model needs to know what they belong to.
 */
const TOOL_IMAGE_CAPTION = '[Attached images returned by the tool call above]';

/**
 * True when the part is a `LanguageModelDataPart` AND the host has the class.
 * The class is resolved at runtime — `part instanceof undefined` would throw,
 * so never test it directly.
 */
export function isDataPart(part: unknown): part is vscode.LanguageModelDataPart {
  return typeof vscode.LanguageModelDataPart === 'function' && part instanceof vscode.LanguageModelDataPart;
}

/** Image parts inside a tool result (text-only tool messages cannot carry them). */
export function imageDataParts(content: readonly unknown[]): vscode.LanguageModelDataPart[] {
  return content.filter(
    (part): part is vscode.LanguageModelDataPart => isDataPart(part) && part.mimeType.startsWith('image/')
  );
}

/** Tool results may carry text parts; flatten them for the gateway. */
export function stringifyToolResult(content: readonly unknown[]): string {
  const chunks: string[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      chunks.push(part.value);
    } else if (isDataPart(part)) {
      // NEVER JSON.stringify a data part: its bytes serialize as a huge
      // numeric-keyed object. Summarise instead — the bytes themselves are
      // forwarded as an image message (see convertMessage) when applicable.
      const bytes = part.data?.byteLength ?? 0;
      chunks.push(`[${part.mimeType.startsWith('image/') ? 'image' : 'data'}: ${part.mimeType}, ${bytes} bytes]`);
    } else {
      chunks.push(safeJsonStringify(part));
    }
  }
  return chunks.join('\n') || '';
}

/** Wrap an image data part into a data URL the gateway can ingest. */
function dataPartToDataUrl(part: vscode.LanguageModelDataPart): string | undefined {
  if (!part.mimeType.startsWith('image/')) {
    return undefined;
  }
  const base64 = Buffer.from(part.data).toString('base64');
  return `data:${part.mimeType};base64,${base64}`;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Rough prompt-token estimate (length/4 heuristic; each image counted flat). */
export function estimatePromptTokens(messages: readonly vscode.LanguageModelChatRequestMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        chars += part.value.length;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        // Mirror what convertMessage actually sends: data parts summarised,
        // images pulled out. Counting the raw part would charge megabytes of
        // JSON for a single screenshot.
        chars += stringifyToolResult(part.content).length;
        images += imageDataParts(part.content).length;
      } else if (isDataPart(part)) {
        images += 1;
      } else {
        chars += safeJsonStringify(part).length;
      }
    }
  }
  return Math.ceil(chars / 4) + images * 800;
}
