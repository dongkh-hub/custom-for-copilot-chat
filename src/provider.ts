/**
 * Native `LanguageModelChatProvider` for any OpenAI-compatible endpoint.
 *
 * A first-class provider (registered through `vscode.lm` under the vendor
 * `custommodel`, declared in `contributes.languageModelChatProviders`), in
 * contrast to a `customendpoint` BYOK group written into Copilot Chat's
 * `chatLanguageModels.json`:
 *
 *   - the model list is CODE-DRIVEN from the shared profile store
 *     (`profileStore.ts`, `customModel.profiles.v2` in the application-scoped
 *     SecretStorage) — every row appears in the picker (and in the Agents
 *     window) where the extension is active, and the SAME rows appear in every
 *     VS Code profile on this machine;
 *   - each profile's API key lives in SecretStorage under
 *     `customModel.apiKey.<profileKey>`; the request path reads it per
 *     request, so a key swap takes effect on the next request;
 *   - each profile's endpoint URL rides in the same shared store, next to its
 *     alias and model id (one group = endpoint + alias + model + key).
 *
 * The endpoint is OpenAI-compatible (`/chat/completions`, SSE streaming, tool
 * calls), so the adapter maps:
 *   VS Code → endpoint: LanguageModelChatRequestMessage → OpenAI messages,
 *                       LanguageModelChatTool → OpenAI tools,
 *                       LanguageModelChatToolMode → tool_choice
 *   endpoint → VS Code: SSE `delta.content` → LanguageModelTextPart,
 *                       SSE `delta.tool_calls` → LanguageModelToolCallPart,
 *                       base64/data-URL images → LanguageModelDataPart,
 *                       final SSE `usage` → terminal `usage` data part that
 *                       Copilot Chat turns into its context-usage widget
 *                       (without it the widget stays at 0% for this provider).
 *
 * CREDENTIALS: VS Code's own provider configuration — declared as a JSON
 * schema under `contributes.languageModelChatProviders[].configuration`
 * (endpoint URL + API key) and handed back on every discovery call as
 * `options.configuration` — is MIRRORED into this extension's storage, where
 * the request path trusts it. Preferring a cached host copy would make a local
 * key swap invisible until the host copy changed too.
 *
 * Errors are mapped to `LanguageModelError` so the chat UI can react:
 * 401/403 → NoPermissions, 404 → NotFound, other 4xx/5xx → generic message
 * with the endpoint's sanitized detail.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_THINKING_EFFORT,
  MODEL_PROVIDER_VENDOR,
  THINKING_EFFORTS,
  decodePickerId,
  encodePickerId,
  modelOutput,
  profileHasCredentials,
  readProfileApiKey,
  resolveProfileEntry,
  resolveThinkingEffort,
  type ModelEntry,
  type Profile,
  type ThinkingEffort,
} from './config';
import {
  applyProfileLimitOverrides,
  firstProfile,
  readProfile,
  readProfiles,
} from './profileStore';
import {
  describeVerdict,
  effortVerdict,
  fallbackEffort,
  recordEffortVerdict,
} from './modelCapability';
import { classifyProviderRequest, type RequestKind } from './requestKind';
import { applyLimitOverrides, readModelLimitOverrides, readThinkingEffortChoice } from './message';
import {
  countRealTools,
  createPreflightToolCallId,
  filterPreflightControlFlow,
  inspectActivatePreflight,
  MAX_PREFLIGHT_ROUNDS,
  pickActivatorToCall,
  summarizeToolSurface,
} from './toolPreflight';
import {
  applyCompatibilityFallback,
  bodyDigest,
  buildRequestBody,
  estimatePromptTokens,
  MAX_COMPATIBILITY_LEVEL,
  safeJsonStringify,
} from './message';
import {
  readErrorDetail,
  responseErrorWithDetail,
  sanitizeDetail,
  streamSseToProgress,
  usageDataPart,
  type GatewayUsage,
} from './stream';
import { createReasoningMarker } from './replay';

/** Detail strings for the model picker (localized — see l10n/bundle.l10n*.json). */
const detailBrand = (profile: Profile): string => {
  // The alias may be arbitrary ("backup", "test 2") — the detail line is the
  // only place the REAL model id and endpoint stay visible, so keep both.
  let host = profile.baseURL;
  try {
    host = new URL(profile.baseURL).host;
  } catch {
    // Not a parsable URL (kept verbatim); the wizard validates it anyway.
  }
  return `${profile.model} · ${host}`;
};
const detailNotConfigured = (): string =>
  vscode.l10n.t(
    'Not configured — run "Custom Mode: Manage Models…" to set the API URL and key.',
  );

/**
 * Model metadata served to VS Code — ONE ENTRY PER CONFIGURED PROFILE.
 *
 * `name` is the user's ALIAS (the whole point of a profile); `id` is the
 * profile-encoded id (`<key>::<model>`) so two profiles serving the same
 * upstream model never collide in VS Code's id-indexed model table. The real
 * model id stays visible in `detail`, and it — never the alias — is what goes
 * into the request body.
 *
 * Listed ALWAYS (while at least one profile exists). Unconfigured each entry
 * carries a warning icon and a setup hint instead of vanishing — an empty
 * model list would leave the picker bare with no hint of what to do next.
 *
 * `statusIcon` / `isBYOK` / `isUserSelectable` are not in the stable
 * `LanguageModelChatInformation` typings yet — Copilot Chat reads the same
 * shape, hence the widening cast. Unknown fields are ignored by hosts that do
 * not know them.
 */
function modelInformation(
  configured: boolean,
  entry: ModelEntry,
  profile: Profile
): vscode.LanguageModelChatInformation {
  const detail = configured ? detailBrand(profile) : detailNotConfigured();
  const pickerId = encodePickerId(profile.key, profile.model);
  return {
    id: pickerId,
    name: profile.name || profile.model,
    // Family groups entries of the same upstream model. Each profile is its
    // own family: two gateways serving the same model id are NOT versions of
    // one another, and folding them would hide one behind a version dropdown.
    family: pickerId,
    version: '1.0.0',
    detail,
    tooltip: detail,
    statusIcon: configured ? undefined : new vscode.ThemeIcon('warning'),
    // Tells Copilot Chat to render this under its BYOK grouping rather than as
    // a first-party model.
    isBYOK: true,
    isUserSelectable: true,
    // DECLARED limits — the model's real window: Copilot Chat sizes the
    // conversation history against maxInputTokens, and the output ceiling is
    // reserved for the answer. Both harnesses read this one number and neither
    // offers a control for it, so the two windows can never disagree about how
    // big this model is (see config.ts).
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    capabilities: {
      imageInput: true,
      toolCalling: true,
    },
    // The gear panel. The schema below is what VS CODE's own picker renders;
    // Copilot's harness ignores it and rebuilds the dropdown from these two
    // top-level fields instead. Declaring the SAME four positions twice — with
    // ids the Copilot side can label — is what makes both windows show one
    // identical dropdown. Unknown fields are ignored by hosts that do not know
    // them.
    configurationSchema: modelConfigurationSchema(entry, profile),
    supportsReasoningEffort: [...THINKING_EFFORTS],
    defaultReasoningEffort: DEFAULT_THINKING_EFFORT,
  } as unknown as vscode.LanguageModelChatInformation;
}

/**
 * The per-model configuration schema VS Code's own picker renders (the gear
 * panel): ONE control, `reasoningEffort` (group `navigation`).
 *
 * This schema is for the ordinary window ONLY. Copilot's harness does not read
 * it at all — it builds its own dropdown from `supportsReasoningEffort` /
 * `defaultReasoningEffort` (see modelInformation) — which is why the positions
 * are declared twice and why their ids must be words that harness can label
 * (see THINKING_EFFORTS in config.ts).
 *
 * There is deliberately NO window control: a `tokens`-group property was
 * rendered by VS Code's picker and silently dropped by Copilot's, so the same
 * model was adjustable in one window and frozen in the other. The window is a
 * declaration (`maxInputTokens`), not a choice.
 *
 * The output ceiling is absent for the same reason: the host offers no group
 * for it.
 */
function modelConfigurationSchema(entry: ModelEntry, profile: Profile): unknown {
  return {
    properties: {
      reasoningEffort: thinkingEffortProperty(profile, entry.id),
    },
  };
}

/**
 * The `reasoningEffort` dropdown.
 *
 * `none` leads and is the default: this provider talks to ANY
 * OpenAI-compatible endpoint, and there is no single spelling for "how hard
 * to think" across them, so the neutral position is the one that puts nothing
 * on the wire. Everything else rides out as `reasoning_effort` verbatim.
 *
 * The title and the labels are deliberately the ones Copilot's harness uses
 * for the same four positions (it builds its own dropdown from
 * `supportsReasoningEffort` and labels the entries itself): the two windows
 * then read the same list, and `enumItemLabels` only adds the localisation
 * that VS Code's picker needs.
 *
 * Positions this endpoint has already REFUSED (see modelCapability.ts) stay in
 * the list — VS Code keeps the chosen value in its own per-model storage, and
 * removing an enum member out from under it is how a picker ends up showing
 * an empty box. They are marked in the description instead, and the request
 * path substitutes a safe value without spending the round-trip.
 */
function thinkingEffortProperty(profile: Profile, model: string): unknown {
  return {
    type: 'string',
    title: vscode.l10n.t('Effort level'),
    description: vscode.l10n.t(
      'How hard this model should think. "None" sends no reasoning parameter at all; the other positions go out as reasoning_effort.'
    ),
    enum: [...THINKING_EFFORTS],
    enumItemLabels: THINKING_EFFORTS.map((effort) => effortLabel(effort)),
    enumDescriptions: THINKING_EFFORTS.map((effort) => learnedEffortDescription(profile, model, effort)),
    default: DEFAULT_THINKING_EFFORT,
    group: 'navigation',
  };
}

/**
 * One description: what the position does on the wire, or — when this endpoint
 * already refused it — what is sent instead. The learned note wins because it
 * describes THIS gateway rather than the parameter in general.
 */
function learnedEffortDescription(profile: Profile, model: string, effort: string): string {
  if (effortVerdict(profile.baseURL, model, effort) !== 'rejected') {
    return effortDescription(effort);
  }
  const fallback = fallbackEffort(profile.baseURL, model);
  return fallback
    ? vscode.l10n.t(
        'This endpoint refused this value — "{0}" is sent instead (learned from an earlier request).',
        fallback
      )
    : vscode.l10n.t(
        'This endpoint refused this value — no reasoning parameter is sent instead (learned from an earlier request).'
      );
}

/**
 * One dropdown label. The wording matches what Copilot's harness prints for the
 * same id, so the two windows read identically; a value it does not know is
 * shown as-is rather than hidden (the enum is fixed, so this is unreachable).
 */
function effortLabel(effort: string): string {
  switch (effort) {
    case 'none':
      return vscode.l10n.t('None');
    case 'low':
      return vscode.l10n.t('Low');
    case 'medium':
      return vscode.l10n.t('Medium');
    case 'high':
      return vscode.l10n.t('High');
    default:
      return effort;
  }
}

/** One dropdown description: what the position does on the wire. */
function effortDescription(effort: string): string {
  switch (effort) {
    case 'none':
      return vscode.l10n.t('Send nothing — the gateway decides');
    case 'low':
      return vscode.l10n.t('Lightest reasoning — fastest, fewest tokens');
    case 'medium':
      return vscode.l10n.t('Balanced reasoning');
    case 'high':
      return vscode.l10n.t('Deepest reasoning — slowest, most tokens');
    default:
      return effort;
  }
}

/** The endpoint + key + REAL model id of ONE profile. */
interface ProviderCredentials {
  url: string;
  /** Empty for a keyless endpoint (`Profile.noAuth`) — then NO auth header is sent. */
  apiKey: string;
  /** The `model` parameter for the request body — never the alias. */
  model: string;
}

/**
 * The credentials to serve ONE profile's requests with. The key lives in
 * SecretStorage under the profile's key; reading it per request is what makes
 * a key swap visible to the very next message.
 *
 * A keyless profile (`noAuth`) resolves WITHOUT a key: the stored `''` is not
 * "missing credentials" there, it is the configured state.
 */
async function resolveCredentials(
  context: vscode.ExtensionContext,
  profile: Profile
): Promise<ProviderCredentials | undefined> {
  const apiKey = await readProfileApiKey(context, profile);
  return profileHasCredentials(profile, apiKey)
    ? { url: profile.baseURL, apiKey, model: profile.model }
    : undefined;
}

/**
 * What to send instead of a gear position this endpoint already refused.
 *
 * `undefined` means "nothing learned, send what the panel says". A learned
 * refusal resolves to `high`, then `low`, then `none` — `none` drops the
 * parameter entirely, which is the only position no gateway can reject.
 */
function learnedEffortFor(
  baseURL: string,
  model: string,
  requested: ThinkingEffort
): ThinkingEffort | undefined {
  if (effortVerdict(baseURL, model, requested) !== 'rejected') {
    return undefined;
  }
  return fallbackEffort(baseURL, model) ?? 'none';
}

/**
 * Does the gateway's error body NAME the effort field? A named field is the
 * only signal precise enough to justify a single-parameter probe; a generic
 * "check the request body" answer is not (see the ladder below).
 */
function namesEffortField(detail: string): boolean {
  return /reasoning[_\s-]?effort/i.test(detail);
}

/**
 * Persist a panel override INTO the profile it came from and re-query the
 * model list. Fire-and-forget from the request/discovery paths: the write is
 * a no-op when the stored value already matches, so a value riding along on
 * every request never churns the settings file.
 */
async function persistLimitOverride(
  profileKey: string,
  overrides: { maxInputTokens?: number; maxOutputTokens?: number }
): Promise<void> {
  try {
    if (await applyProfileLimitOverrides(profileKey, overrides)) {
        modelOutput().appendLine(
          `[limits] ${profileKey} → ${describeOverrides(overrides)} (stored in the group, picker re-queried)`
        );
      notifyProviderChanged();
    }
  } catch (err) {
    modelOutput().appendLine(`[limits] persisting failed — ${String(err)}`);
  }
}

/** One log line for an override: `in=524288`, `out=0 (default)`, … */
function describeOverrides(overrides: { maxInputTokens?: number; maxOutputTokens?: number }): string {
  const part = (name: string, value: number | undefined): string =>
    value === undefined ? '' : `${name}=${value > 0 ? value : 'default'}`;
  return [part('in', overrides.maxInputTokens), part('out', overrides.maxOutputTokens)]
    .filter(Boolean)
    .join(' ');
}

/**
 * The registered provider instance. Registered once per activation; VS Code
 * calls back into it for model discovery (`provideLanguageModelChatInformation`),
 * chat requests (`provideLanguageModelChatResponse`) and token counting.
 */
export function registerModelProvider(context: vscode.ExtensionContext): vscode.Disposable {
  // Durable diagnostics: every request stage lands in
  // `<globalStorage>/custom-for-copilot-chat.log` so a failure can still be
  // diagnosed after the output channel has moved on.
  setDiagnosticLogDir(context.globalStorageUri);
  const provider: vscode.LanguageModelChatProvider = {
    onDidChangeLanguageModelChatInformation: providerChangedEmitter().event,

    async provideLanguageModelChatInformation(_options, _token) {
      // One row PER PROFILE, whether or not its key is present: this callback
      // never prompts (it only reports metadata), and a model that vanishes
      // from the picker leaves the user with nothing to click. Silent
      // background enumeration gets the same entries — an unconfigured model
      // is still a real model.
      // (Panel limit overrides are persisted from the REQUEST path, which
      // knows the profile; VS Code already rides the new value into the very
      // next request, so no discovery-side write is needed.)
      return Promise.all(
        readProfiles().map(async (profile) =>
          modelInformation(
            profileHasCredentials(profile, await readProfileApiKey(context, profile)),
            resolveProfileEntry(profile),
            profile
          )
        )
      );
    },

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      // Staged timing: see logStage for what each gap means.
      const rid = ++requestSeq;
      const t0 = Date.now();
      logStage(rid, 'response.enter', t0, `model=${model.id}`);

      // The picker id is `<profileKey>::<model>`; a bare/unrecognized id
      // falls back to the first profile.
      const decoded = decodePickerId(model.id);
      const profile = decoded ? readProfile(decoded.key) : firstProfile();
      const credentials = profile ? await resolveCredentials(context, profile) : undefined;
      if (!profile || !credentials) {
        logStage(
          rid,
          'response.error',
          t0,
          profile
            ? `profile ${profile.key} has no API key and is not keyless (noAuth)`
            : `unknown profile in model id ${model.id}`
        );
        throw vscode.LanguageModelError.NoPermissions(
          vscode.l10n.t(
            'Custom for Copilot Chat is not configured (API key missing). Run "Custom Mode: Manage Models…" to add one.'
          )
        );
      }
      const entry = resolveProfileEntry(profile);
      const { url } = credentials;
      const apiKey = credentials.apiKey;

      // WHO is asking? Copilot Chat routes chat titles, commit messages, todo
      // tracking and settings resolution through the same model as the agent
      // — and every one of them spends the same API key. See requestKind.ts
      // (the kind also drives the utility downgrade inside buildRequestBody).
      const requestKind = classifyProviderRequest({ messages, tools: options.tools });

      // VS Code's `activate_*` handshake: emit the missing activation calls
      // and return WITHOUT sending anything (see toolPreflight.ts).
      const requestMessages = runToolPreflight(rid, t0, messages, options, progress, requestKind);
      if (!requestMessages) {
        return; // preflight handled the round — no token spent
      }

      const requestNotes: string[] = [];
      // A hand-set token limit rides along on the request (>0 = custom value,
      // 0 = cleared — restore the default). Applied to this request
      // immediately, and persisted into the group (shared credential store) so
      // the picker, other windows and other VS Code profiles follow. There is
      // no gear control for the window any more — this is the profile setting.
      const limitOverrides = readModelLimitOverrides(options);
      if (limitOverrides.maxInputTokens !== undefined || limitOverrides.maxOutputTokens !== undefined) {
        void persistLimitOverride(profile.key, limitOverrides);
      }
      const effectiveEntry = applyLimitOverrides(entry, limitOverrides);
      // The effort position picked in the model's configuration panel (absent on
      // an older host → `none`, which sends nothing).
      const requestedEffort = resolveThinkingEffort(readThinkingEffortChoice(options));
      // ...then the LEARNED override. A value this endpoint already answered
      // 400 to is replaced by a safe one BEFORE the request goes out: the
      // round-trip that discovered it is paid once, not on every message.
      const learnedEffort = learnedEffortFor(profile.baseURL, entry.id, requestedEffort);
      const effort = learnedEffort ?? requestedEffort;
      if (learnedEffort !== undefined) {
        requestNotes.push(`effort ${requestedEffort} learned-refused → ${effort}`);
      }
      const body = buildRequestBody(effectiveEntry, effort, requestMessages, options, requestKind, requestNotes);
      // The effort value actually on the wire, captured BEFORE any retry
      // mutates `body` — attribution needs to know WHAT was refused, and the
      // probe deletes the property.
      const sentEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
      // Fallback usage numbers when the gateway cannot report usage itself —
      // keeps the chat context-usage widget alive on strict/legacy gateways.
      const estimatedPromptTokens = estimatePromptTokens(requestMessages);
      // A keyless endpoint gets NO Authorization header at all. Sending
      // `Bearer ` (empty) only works where auth is ignored entirely; a proxy
      // in front of the same model treats the header's PRESENCE as a
      // credential and answers 401, so omitting it is the portable form.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const send = (payload: Record<string, unknown>) =>
        fetch(`${url}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: abortFromToken(token),
        });

      // Request shape only — counts and flags, never message content.
      const shape =
        `kind=${requestKind} effort=${effort} messages=${requestMessages.length}` +
        ` tools=${'tools' in body ? (body.tools as unknown[]).length : 0}` +
        ` max_tokens=${'max_tokens' in body ? body.max_tokens : '-'}` +
        ` stream_options=${'stream_options' in body}` +
        ` adjusted=${requestNotes.length > 0 ? requestNotes.join('; ') : '-'}`;
      try {
        logStage(rid, 'request.start', t0, shape);
        let response = await send(body);
        logStage(rid, 'response.headers', t0, `status=${response.status}`);

        if (!response.ok) {
          // Read the error body EXACTLY once per attempt: a second .text() on
          // an already consumed body throws, which would silently strip the
          // detail. Read at the CHANNEL limit; the chat message truncates.
          let detail = await readErrorDetail(response, CHANNEL_DETAIL_LIMIT);
          // A context overflow is NOT a shape problem: no compatibility level
          // removes tokens, so walking the ladder would burn four identical
          // failing requests and then report a shape error for a size
          // problem. This is the one failure that shows up as "it worked for
          // a while and then started erroring": the conversation grew past
          // the gateway's real window while the declared window still had
          // room.
          if (isContextOverflow(response.status, detail)) {
            logStage(rid, 'request.overflow', t0, `status=${response.status} body=${bodyDigest(body)}`);
            // Some gateways count `prompt_tokens + max_tokens` against the
            // window, so a large output reservation rejects a request that
            // would otherwise fit. Dropping it gives the request the best
            // chance of landing without touching the conversation.
            if ('max_tokens' in body) {
              delete body.max_tokens;
              logStage(rid, 'request.overflow', t0, 'retrying without max_tokens');
              const retried = await send(body);
              logStage(rid, 'response.headers', t0, `status=${retried.status} (overflow retry)`);
              response = retried;
              if (!retried.ok) {
                detail = await readErrorDetail(retried, CHANNEL_DETAIL_LIMIT);
              }
            }
            if (!response.ok) {
              logRejected(rid, response.status, body, detail);
              throw new vscode.LanguageModelError(
                vscode.l10n.t(
                  'The gateway rejected this request as too long (conversation exceeds the model window). Start a new chat, or lower the model\'s input limit in "Manage Models…". Gateway said: {0}',
                  sanitizeDetail(detail) || `HTTP ${response.status}`
                )
              );
            }
          }
          // PRECISE PROBE before the ladder: drop the effort ALONE and retry.
          //
          // A retry that differs by exactly one parameter is proof about that
          // parameter, and it does not need the error body to cooperate — most
          // strict gateways answer with a generic "check the request body".
          // Waiting for the ladder to reach the effort means dropping six
          // parameters at once, which proves nothing (see the attribution rule
          // below) and costs three extra round-trips.
          //
          // Only the effort gets this treatment: it is the one optional field
          // the USER chose and the one whose value set every vendor disagrees
          // about. A gateway that refuses something else answers 400 again
          // here and the ladder takes over, one request poorer.
          if (response.status === 400 && typeof body.reasoning_effort === 'string') {
            const refused = body.reasoning_effort;
            delete body.reasoning_effort;
            logStage(
              rid,
              'request.probe',
              t0,
              `dropped=reasoning_effort(${refused}) named=${namesEffortField(detail)}`
            );
            const probed = await send(body);
            logStage(rid, 'response.headers', t0, `status=${probed.status} (effort probe)`);
            if (probed.ok) {
              response = probed;
              void recordEffortVerdict(profile.baseURL, entry.id, refused, 'rejected', detail).then(
                (changed) => {
                  if (!changed) {
                    return;
                  }
                  modelOutput().appendLine(
                    `[capability] learned: ${describeVerdict(profile.baseURL, entry.id) ?? `${refused} refused`}`
                  );
                  // The gear panel reads this store: re-query so the refused
                  // position is annotated on the very next open.
                  notifyProviderChanged();
                }
              ).catch(() => undefined);
            } else {
              response = probed;
              detail = await readErrorDetail(probed, CHANNEL_DETAIL_LIMIT);
            }
          }
          // Strict/legacy gateways reject parameters or message shapes they do
          // not model instead of ignoring them, and most of them answer with a
          // GENERIC body that names no field. So a 400 walks a compatibility
          // LADDER: each level removes one more class of optional surface and
          // retries once (see applyCompatibilityFallback in message.ts).
          // 401/403/404/5xx are never retried — they are about credentials,
          // routing or the upstream itself, and a smaller body cannot fix any
          // of those.
          for (let level = 1; level <= MAX_COMPATIBILITY_LEVEL && response.status === 400; level += 1) {
            const removed = applyCompatibilityFallback(body, level, detail);
            if (removed.length === 0) {
              continue; // nothing left for this level — try the next one
            }
            logStage(
              rid,
              'request.fallback',
              t0,
              `level=${level} dropped=${removed.join(',')} body=${bodyDigest(body)}`
            );
            const retried = await send(body);
            logStage(rid, 'response.headers', t0, `status=${retried.status} (fallback ${level})`);
            if (retried.ok) {
              // NO LEARNING HERE. This retry may have removed several
              // parameters at once, so success does not say WHICH one the
              // gateway minded — the probe above is the only place precise
              // enough to record a verdict.
              response = retried;
              break;
            }
            response = retried;
            detail = await readErrorDetail(retried, CHANNEL_DETAIL_LIMIT);
          }
          if (!response.ok) {
            // Every other 4xx/5xx surfaces WITH its sanitized gateway detail
            // instead of being swallowed. The channel gets the long version —
            // the chat bubble only has room for the first sentence, and the
            // useful part of a gateway rejection is often at the END of its
            // JSON.
            logRejected(rid, response.status, body, detail);
            throw responseErrorWithDetail(response.status, sanitizeDetail(detail));
          }
        }
        // A 200 is proof this body was accepted, effort included. Remembering
        // the POSITIVE case keeps the learning honest: one failure elsewhere
        // must not make the picker mark a position this gateway does serve.
        if (sentEffort && body.reasoning_effort === sentEffort) {
          void recordEffortVerdict(profile.baseURL, entry.id, sentEffort, 'supported').catch(
            () => undefined
          );
        }
        if (!response.body) {
          throw new Error('gateway returned an empty response body');
        }

        const {
          usage: gatewayUsage,
          completionChars,
          thinkingChars,
          thinkingReported,
          reasoning,
        } = await streamSseToProgress(response.body, progress, token, () => {
          logStage(rid, 'response.firstChunk', t0);
        });
        // One line per request that carries reasoning answers whether THIS
        // gateway reasons at all, from the log alone.
        if (thinkingChars > 0) {
          logStage(rid, 'response.thinking', t0, `chars=${thinkingChars} shown=${thinkingReported}`);
        }
        // Hand this turn's chain of thought to the HOST as an opaque data
        // part, so the next request can replay it as `reasoning_content`
        // (replay.ts). Only on a clean finish: a cancelled turn's reasoning is
        // partial, and replaying a truncated chain is worse than none.
        if (!token.isCancellationRequested && reasoning) {
          const marker = createReasoningMarker(reasoning);
          if (marker) {
            // Wrapped: a host that rejects an unexpected data part must not
            // fail a response that has already streamed to the user. The
            // cost of a failure here is only "no replay next turn".
            try {
              progress.report(marker);
              logStage(rid, 'response.replay', t0, `chars=${reasoning.length}`);
            } catch (err) {
              logStage(rid, 'response.replay', t0, `skipped: ${sanitizeDetail(String(err))}`);
            }
          }
        }

        // Copilot Chat's BYOK path consumes a terminal `usage` data part and
        // forwards it to the chat context-usage widget; without it the widget
        // renders 0% for models served by this provider.
        const usage: GatewayUsage = gatewayUsage ?? {
          prompt_tokens: estimatedPromptTokens,
          completion_tokens: Math.ceil(completionChars / 4),
        };
        if ((usage.prompt_tokens ?? 0) > 0 || (usage.completion_tokens ?? 0) > 0) {
          progress.report(usageDataPart(usage));
        }
        if (token.isCancellationRequested) {
          logStage(rid, 'response.cancelled', t0, `chars=${completionChars}`);
        } else {
          logStage(
            rid,
            'response.complete',
            t0,
            `chars=${completionChars} tokens=${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`
          );
        }
      } catch (err) {
        if (token.isCancellationRequested) {
          logStage(rid, 'response.cancelled', t0);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          logStage(rid, 'response.error', t0, sanitizeDetail(message));
        }
        throw err;
      }
    },

    async provideTokenCount(_model, text, _token) {
      // Cheap heuristic — arbitrary endpoints expose no tokenizer endpoint.
      // ~4 chars per token is the usual English approximation; CJK-heavy
      // prompts under-count, which is safe (only used for context-window
      // budgeting hints).
      const length =
        typeof text === 'string'
          ? text.length
          : messageTextLength(text);
      return Math.ceil(length / 4);
    },
  };

  return vscode.lm.registerLanguageModelChatProvider(MODEL_PROVIDER_VENDOR, provider);
}

/**
 * Fired by the setup wizard after URL/key changes so VS Code re-queries.
 * Created lazily: unit-test `vscode` stubs have no EventEmitter, and the
 * module is loaded transitively by them — a top-level `new
 * vscode.EventEmitter()` would crash those loads.
 */
let providerChanged: vscode.EventEmitter<void> | undefined;
function providerChangedEmitter(): vscode.EventEmitter<void> {
  providerChanged ??= new vscode.EventEmitter<void>();
  return providerChanged;
}

/** Signal VS Code that the model set may have changed (after setup/settings edit). */
export function notifyProviderChanged(): void {
  providerChangedEmitter().fire();
}

// --- Staged request timing -----------------------------------------------------
//
// One line per stage, each with the elapsed ms since the request entered the
// provider. The GAPS between stages answer where the wall time goes:
//
//   response.enter → request.start    provider prep (URL/secret reads, body build)
//   request.start → response.headers  network + gateway time-to-first-byte
//   response.headers → firstChunk     model inference up to the first body byte
//   firstChunk → response.complete    streaming (tokens, tool calls, usage)
//
// Lines carry counts and statuses only: never message content, never the API
// key.

let requestSeq = 0;

/**
 * How much of a non-2xx body is kept for the OUTPUT CHANNEL. The cgateway
 * rejection often puts the useful part of its JSON at the END — truncating
 * there is what turns "the gateway named the field" into "the request was
 *ting there is
 * what turns "the gateway named the field" into "the request was invalid".
 */
const CHANNEL_DETAIL_LIMIT = 2000;

function logStage(rid: number, stage: string, startedAt: number, extra?: string): void {
  const elapsed = Date.now() - startedAt;
  const line = `rid=${rid} ${stage} +${elapsed}ms${extra ? ` (${extra})` : ''}`;
  console.log(`[CustomModel] ${line}`);
  // Every stage also lands in a FILE (see setDiagnosticLogDir): the output
  // channel is in-memory, so a failure the user reported five minutes ago is
  // gone by the time anyone looks — and "it works, then it starts erroring"
  // can only be explained by comparing the requests that succeeded with the
  // one that did not.
  appendDiagnosticLine(line);
  // Handshake / tool-surface stages and failures also go to a visible channel:
  // `console.log` only reaches the debug console, and this is exactly the
  // diagnostic a user reports ("the agent has no tools") without wanting to
  // attach a debugger.
  if (stage.startsWith('preflight.') || isFailureStatusLine(stage, extra)) {
    modelOutput().appendLine(`${new Date().toISOString()} ${line}`);
  }
}

/**
 * The one line that matters after a rejection: status, the message-shape
 * fingerprint, and the gateway's own words. Written to BOTH the channel and
 * the diagnostic file.
 */
function logRejected(
  rid: number,
  status: number,
  body: Record<string, unknown>,
  detail: string
): void {
  const line =
    `rid=${rid} response.rejected status=${status}` +
    ` body=${bodyDigest(body)} detail=${detail || '(empty)'}`;
  modelOutput().appendLine(`${new Date().toISOString()} ${line}`);
  appendDiagnosticLine(line);
}

/**
 * Does this rejection mean "the conversation is bigger than the model window"?
 *
 * Deliberately narrow: only a 400/413/422 whose text actually talks about
 * context/length. A false positive here would skip the compatibility ladder
 * for a shape problem it could have fixed, which is worse than a missed
 * overflow (that one still surfaces as a normal 400).
 */
function isContextOverflow(status: number, detail: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) {
    return false;
  }
  if (!detail) {
    return false;
  }
  const text = detail.toLowerCase();
  return (
    /maximum context|context (length|window)|context_length_exceeded|too many tokens|token limit|reduce the length|prompt is too long|input is too long/.test(
      text
    ) ||
    /(prompt|input|messages?)[^.]{0,40}(too long|exceed\w*|maximum)/.test(text) ||
    text.includes('上下文')
  );
}

// --- Durable diagnostics -------------------------------------------------------
//
// `context.globalStorageUri` is the only writable location this extension owns;
// the file is capped at ~1 MB with a single `.1` generation, so a long-running
// install cannot fill the disk.

const DIAGNOSTIC_LOG_NAME = 'custom-for-copilot-chat.log';
const DIAGNOSTIC_LOG_MAX_BYTES = 1_000_000;

let diagnosticLogPath: string | undefined;
let diagnosticWrites = 0;

/** Point the diagnostic log at the extension's storage folder (activation). */
export function setDiagnosticLogDir(storageUri: vscode.Uri | undefined): void {
  diagnosticLogPath = storageUri ? path.join(storageUri.fsPath, DIAGNOSTIC_LOG_NAME) : undefined;
  if (diagnosticLogPath) {
    appendDiagnosticLine(`--- session start · host ${vscode.version} ---`);
  }
}

function appendDiagnosticLine(line: string): void {
  if (!diagnosticLogPath) {
    return;
  }
  try {
    fs.appendFileSync(diagnosticLogPath, `${new Date().toISOString()} ${line}\n`);
    diagnosticWrites += 1;
    if (diagnosticWrites % 200 === 0 && fs.statSync(diagnosticLogPath).size > DIAGNOSTIC_LOG_MAX_BYTES) {
      fs.renameSync(diagnosticLogPath, `${diagnosticLogPath}.1`);
      diagnosticWrites = 0;
    }
  } catch {
    // Diagnostics must never fail a request (read-only fs, revoked perms…).
  }
}

/**
 * `response.headers` carrying a non-2xx status — the point where a failure
 * path begins.
 */
function isFailureStatusLine(stage: string, extra: string | undefined): boolean {
  if (stage !== 'response.headers' || !extra) {
    return false;
  }
  const match = /status=(\d{3})/.exec(extra);
  return match !== null && Number(match[1]) >= 400;
}

/** Bridge a CancellationToken into an AbortSignal for fetch. */
function abortFromToken(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    const subscription = token.onCancellationRequested(() => controller.abort());
    // No dispose hook here: the fetch settles (rejects with AbortError) the
    // moment the abort fires, and the subscription dies with the token.
    void subscription;
  }
  return controller.signal;
}

/**
 * VS Code's `activate_*` handshake (see toolPreflight.ts).
 *
 * Returns the messages to send, or `undefined` when the round was consumed by
 * the handshake itself — in that case NOTHING is sent to the gateway, which is
 * the whole point: activation is free.
 */
function runToolPreflight(
  rid: number,
  startedAt: number,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  requestKind: RequestKind
): readonly vscode.LanguageModelChatRequestMessage[] | undefined {
  const preflight = inspectActivatePreflight(messages, options.tools);
  const activator = pickActivatorToCall(preflight);
  if (activator) {
    if (preflight.rounds >= MAX_PREFLIGHT_ROUNDS) {
      // A list that never expands would ping-pong forever, each round a
      // full-price request. Stop instead of looping.
      logStage(
        rid,
        'preflight.abort',
        startedAt,
        `kind=${requestKind} tool activation still incomplete after ${preflight.rounds} rounds`
      );
      throw new vscode.LanguageModelError(
        vscode.l10n.t(
          'Custom for Copilot Chat: tool activation did not complete after {0} rounds.',
          String(MAX_PREFLIGHT_ROUNDS)
        )
      );
    }
    const nextRound = preflight.rounds + 1;
    logStage(
      rid,
      'preflight.activate',
      startedAt,
      `kind=${requestKind} round=${nextRound} group=${activator} unused=${preflight.remainingActivatorNames.length - 1}` +
        ` surface=${summarizeToolSurface(options.tools)}`
    );
    // ONE activator only: groups are mutually exclusive on the host, so more
    // calls would revoke the group this one brings in (see toolPreflight.ts).
    progress.report(
      new vscode.LanguageModelToolCallPart(
        createPreflightToolCallId(nextRound, activator),
        activator,
        {}
      )
    );
    return undefined;
  }

  // Report the surface EVERY request will carry. This is the one observable
  // for two questions that otherwise have no answer from inside the provider:
  // did the host fold the list at all, and (after activation) which capability
  // group is actually live.
  const surface = summarizeToolSurface(options.tools);
  const real = countRealTools(options.tools);
  if (real === 0 && preflight.activatorNames.length > 0) {
    logStage(rid, 'preflight.drift', startedAt, `kind=${requestKind} no tool expanded ${surface}`);
  } else {
    logStage(
      rid,
      'preflight.ready',
      startedAt,
      `kind=${requestKind} ${surface} activated=${preflight.calledActivatorNames.join('|') || 'none'}`
    );
  }
  return filterPreflightControlFlow(messages);
}

function messageTextLength(message: vscode.LanguageModelChatRequestMessage): number {
  let total = 0;
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      total += part.value.length;
    } else {
      total += safeJsonStringify(part).length;
    }
  }
  return total;
}
