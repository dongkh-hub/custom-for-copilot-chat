/**
 * Request classification — "who is asking?" before we spend the user's quota.
 *
 * Copilot Chat sends far more than the user's own turns through the same
 * model: chat titles, todo tracking, commit messages, branch names, settings
 * resolution, prompt categorization… With `chat.utilityModel` /
 * `chat.utilitySmallModel` / `chat.byokUtilityModelDefault` all pointing at
 * this provider (see hostDefaults.ts), every one of those helper calls burns
 * the SAME API key as the main agent.
 *
 * So each request is classified from two cheap signals (the leading system
 * prompt text and the tool names) and utility classes get DOWNGRADED:
 *
 *   - text-only helpers (title / commit message / branch name / progress
 *     message / settings resolver / rename) go out without `tools` and with a
 *     low `max_tokens` — they answer in a sentence, not a page;
 *   - tool-shaped helpers (todo tracker, prompt categorizer) keep their single
 *     tool (removing it would break the round-trip) but are still eligible for
 *     thinking suppression;
 *   - `main-agent` and `terminal-steering` are never touched.
 *
 * The prefixes are Copilot Chat's own English system prompts. They are
 * heuristics — a miss falls through to `background`/`unknown`, which is
 * treated as "not utility" and therefore never downgraded. Failing OPEN is
 * deliberate: a wrongly-classified helper costs a few tokens, a
 * wrongly-classified main-agent turn would silently cripple it.
 */
import * as vscode from 'vscode';

export type RequestKind =
  | 'main-agent'
  | 'terminal-steering'
  | 'todo-tracker'
  | 'settings-resolver'
  | 'prompt-categorizer'
  | 'chat-title'
  | 'inline-progress-message'
  | 'git-branch-name'
  | 'git-commit-message'
  | 'rename-suggestions'
  | 'background'
  | 'unknown';

const TODO_TRACKER_PREFIX = 'You are a background task tracker';
const PROMPT_CATEGORIZER_PREFIX = 'You are an expert classifier for AI coding assistant prompts';
const SETTINGS_RESOLVER_PREFIX =
  'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings';
const CHAT_TITLE_PREFIXES = [
  'You are an expert in crafting ultra-compact titles',
  'You are an expert in crafting pithy titles',
] as const;
const INLINE_PROGRESS_MESSAGE_PREFIX =
  'You are an expert in writing short, catchy, and encouraging progress messages';
const GIT_BRANCH_NAME_PREFIX = 'You are an expert in crafting pithy branch names';
const GIT_COMMIT_MESSAGE_PREFIX =
  'You are an AI programming assistant, helping a software developer to come with the best git commit message';
const RENAME_SUGGESTIONS_PREFIX = 'You are a distinguished software engineer';
const MAIN_AGENT_PREFIX = 'You are an expert AI programming assistant';
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;

/** Helper classes that answer with plain text and never need a tool. */
const TEXT_ONLY_UTILITY_KINDS = new Set<RequestKind>([
  'chat-title',
  'inline-progress-message',
  'git-branch-name',
  'git-commit-message',
  'rename-suggestions',
  'settings-resolver',
]);

/** Helper classes whose ONLY tool IS the request — stripping it would break them. */
const TOOL_UTILITY_KINDS = new Set<RequestKind>(['todo-tracker', 'prompt-categorizer']);

/**
 * What to take away from a request once we know who is asking.
 *
 * `maxOutputTokens: undefined` means "leave the gateway's own default alone" —
 * the only always-safe choice for classes where we cannot bound the answer.
 */
export interface UtilityDowngrade {
  /** Drop `tools` / `tool_choice` from the payload. */
  stripTools: boolean;
  /** Clamp `max_tokens` — `undefined` keeps the gateway default. */
  maxOutputTokens?: number;
  /** Ask the gateway to skip reasoning (no disable parameter is ever sent today). */
  disableThinking: boolean;
}

const NO_DOWNGRADE: UtilityDowngrade = {
  stripTools: false,
  disableThinking: false,
};

/** Is this class a Copilot Chat helper rather than a user-facing turn? */
export function isUtilityKind(kind: RequestKind): boolean {
  return TEXT_ONLY_UTILITY_KINDS.has(kind) || TOOL_UTILITY_KINDS.has(kind);
}

/**
 * The downgrade for a class. Callers pass the ceiling (fixed at
 * `UTILITY_MAX_OUTPUT_TOKENS`) — this module deliberately owns no
 * configuration reads so it stays unit-testable.
 */
export function utilityDowngrade(kind: RequestKind, maxOutputTokens: number): UtilityDowngrade {
  // A non-positive ceiling means "do not clamp" — sending `max_tokens: 0`
  // would ask the gateway for an empty answer.
  const clamp = maxOutputTokens > 0 ? maxOutputTokens : undefined;
  if (TEXT_ONLY_UTILITY_KINDS.has(kind)) {
    return { stripTools: true, maxOutputTokens: clamp, disableThinking: true };
  }
  if (TOOL_UTILITY_KINDS.has(kind)) {
    // The single tool is the whole point of the call — keep it, and do not
    // bound the output (a todo list / category list length is model-driven).
    return { stripTools: false, disableThinking: true };
  }
  return NO_DOWNGRADE;
}

/** Classify a request as it arrives from VS Code. */
export function classifyProviderRequest(input: {
  messages: readonly vscode.LanguageModelChatRequestMessage[];
  tools?: readonly vscode.LanguageModelChatTool[];
}): RequestKind {
  return classifyRequestShape({
    firstText: getFirstText(input.messages),
    latestUserText: getLatestUserText(input.messages),
    toolNames: input.tools?.map((tool) => tool.name) ?? [],
  });
}

/** Pure classifier: the whole decision from three already-extracted signals. */
export function classifyRequestShape(input: {
  firstText: string;
  latestUserText: string;
  toolNames: readonly string[];
}): RequestKind {
  const firstText = input.firstText.trimStart();
  const latestUserText = input.latestUserText.trimStart();
  if (TERMINAL_NOTIFICATION_PATTERN.test(latestUserText)) {
    return 'terminal-steering';
  }
  if (isOnlyTool(input.toolNames, 'manage_todo_list') || firstText.startsWith(TODO_TRACKER_PREFIX)) {
    return 'todo-tracker';
  }
  if (
    isOnlyTool(input.toolNames, 'categorize_prompt') ||
    firstText.startsWith(PROMPT_CATEGORIZER_PREFIX)
  ) {
    return 'prompt-categorizer';
  }
  if (firstText.startsWith(SETTINGS_RESOLVER_PREFIX)) {
    return 'settings-resolver';
  }
  if (startsWithAny(firstText, CHAT_TITLE_PREFIXES)) {
    return 'chat-title';
  }
  if (firstText.startsWith(INLINE_PROGRESS_MESSAGE_PREFIX)) {
    return 'inline-progress-message';
  }
  if (firstText.startsWith(GIT_BRANCH_NAME_PREFIX)) {
    return 'git-branch-name';
  }
  if (firstText.startsWith(GIT_COMMIT_MESSAGE_PREFIX)) {
    return 'git-commit-message';
  }
  if (firstText.startsWith(RENAME_SUGGESTIONS_PREFIX)) {
    return 'rename-suggestions';
  }
  if (
    firstText.startsWith(MAIN_AGENT_PREFIX) ||
    firstText.includes('<skills>') ||
    firstText.includes('<agents>')
  ) {
    return 'main-agent';
  }
  if (input.toolNames.length > 0 || firstText.length > 0) {
    return 'background';
  }
  return 'unknown';
}

function isOnlyTool(toolNames: readonly string[], toolName: string): boolean {
  return toolNames.length === 1 && toolNames[0] === toolName;
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}

/** Text of the FIRST message (Copilot puts its system prompt there). */
function getFirstText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  const first = messages[0];
  return first ? messageText(first) : '';
}

/** Text of the LAST user message (terminal steering is injected there). */
function getLatestUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      return messageText(message);
    }
  }
  return '';
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  let text = '';
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}
