/**
 * Configuration surface: the profile SHAPE, state keys, official model presets
 * and the thinking-effort gear.
 *
 * The configured list itself does NOT live here — `profileStore.ts` owns it,
 * in the user-level credential store (`customModel.profiles.v2`), so every VS
 * Code profile on this machine sees the same groups. This module owns what a
 * group IS ({ key, name, baseURL, model, noAuth?, maxInputTokens,
 * maxOutputTokens }) and everything derived from it: the official preset
 * chain, the picker id encoding and the thinking-effort gear. API keys stay in
 * SecretStorage too, under
 * `customModel.apiKey.<profileKey>`. The request path reads the list and the
 * key PER REQUEST — a swap takes effect on the next chat message with no
 * reload.
 *
 * Token limits follow a fixed chain:
 *
 *   explicit `maxInputTokens`/`maxOutputTokens` setting (> 0)
 *     > the preset detected from the model id (official vendor figures)
 *     > the 1M/128K mainstream default
 *
 * `0` (the default) means "auto": the preset chain rules. Everything else
 * this extension does (helper-request downgrade, tool-list stabilization,
 * thinking passthrough) is fixed behavior — there are no hidden switches.
 *
 * The window is a DECLARATION, not a control. There used to be a second gear
 * dropdown that capped `maxInputTokens` onto a fixed ladder; it was removed
 * because only ONE of the two harnesses renders it (VS Code's own picker draws
 * the `tokens` group, Copilot's does not), which made the same model adjustable
 * in one window and silently fixed in the other. Copilot compacts on its own at
 * ~80% of the declared window, so capping bought earlier compaction and nothing
 * else. To run a model on a smaller window, set the limit on the profile (or
 * add a second profile whose model id maps to that window).
 *
 * The preset REGEXES recognize the ids of mainstream models so their limits
 * apply automatically; the preset ids/labels stay neutral (alpha/beta/gamma)
 * so nothing vendor-specific surfaces in the wizard summary or docs. There
 * is NO universal input:output ratio — each model caps output per id, and
 * reasoning models keep their own (larger) output budget because reasoning
 * tokens count toward it. When a gateway serves ids no preset recognizes,
 * the mainstream default applies and the profile's limits can pin real numbers.
 */
import * as vscode from 'vscode';

/** LM provider vendor — MUST match `contributes.languageModelChatProviders[].vendor`. */
export const MODEL_PROVIDER_VENDOR = 'custommodel';

/** One-shot markers in globalState. */
export const STATE_KEYS = {
  AGENT_WINDOW_DEFAULTS: 'customModel.agentWindowDefaultsApplied',
  SETUP_HINT: 'customModel.setupHintShown',
  CHAT_HINT: 'customModel.copilotChatHintShown',
} as const;

/**
 * Mainstream default for ids no preset matches (flagship tier, 2026):
 * 1M window / 128K output. Overdeclaring the WINDOW makes the host send more
 * history than a smaller model supports — if a request 400s on long
 * conversations, pin the real numbers (or 0 = auto) in settings.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 1048576;
export const DEFAULT_MAX_OUTPUT_TOKENS = 131072;

/** Official input/output limits of one known model. */
export interface ModelLimits {
  /**
   * Declared prompt budget the HOST sizes the conversation history against.
   * The model's real window (preset figure or mainstream default) unless the
   * profile pins a number — there is no gear control for it any more (see the
   * module docblock).
   */
  readonly maxInputTokens: number;
  /** Declared output ceiling reserved for the answer. */
  readonly maxOutputTokens: number;
  /**
   * Thinking/reasoning model (from the preset detected for the model id).
   * Reported in the resolved entry so the picker and the request log can tell
   * a reasoning model apart; nothing clamps differently on it any more — the
   * thinking-effort gear is the user's call now.
   */
  readonly reasoning?: boolean;
}

/** One vendor-preset: limits + how the model id is recognized. */
export interface ModelPreset extends ModelLimits {
  /** Preset id. */
  readonly id: string;
  /** Human label for the wizard summary / settings docs. */
  readonly label: string;
  /** Case-insensitive match against the model id. Order matters (first hit wins). */
  readonly match: RegExp;
}

/**
 * Official presets, checked in order. Narrow ids (thinking variants,
 * 4.6) MUST precede their family catch-alls.
 */
const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'alpha-4.1',
    label: 'Alpha 4.1 (1M/32K)',
    match: /^gpt-4\.1/i,
    maxInputTokens: 1047576,
    maxOutputTokens: 32768,
  },
  {
    id: 'alpha-5',
    label: 'Alpha 5 (272K/128K)',
    match: /^gpt-5/i,
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
  },
  {
    id: 'alpha-4o',
    label: 'Alpha 4o (128K/16K)',
    match: /^gpt-4o/i,
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
  },
  {
    // Thinking mode: the reasoner/r1/thinking suffix routes to the thinking
    // preset; reasoning tokens count toward the output budget, so the entry
    // is flagged.
    id: 'beta-thinking',
    label: 'Beta thinking (1M/128K)',
    match: /deepseek[-_.]?(reasoner|r1|thinking)/i,
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
    reasoning: true,
  },
  {
    // deepseek-chat / deepseek / dsv4 / v4 / v4-flash / v4-pro …
    id: 'beta-v4',
    label: 'Beta V4 (1M/128K)',
    match: /deepseek|dsv4|^v4[-_.]?(flash|pro)?/i,
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
  },
  {
    id: 'gamma-5',
    label: 'Gamma 5 (1M/128K)',
    match: /glm[-_.]?5/i,
    maxInputTokens: 1048576,
    maxOutputTokens: 131072,
  },
  {
    id: 'gamma-4.6',
    label: 'Gamma 4.6 (200K/128K)',
    match: /glm[-_.]?4\.6/i,
    maxInputTokens: 200000,
    maxOutputTokens: 131072,
  },
];

/** The preset an id maps to (first hit), or `undefined`. */
export function detectModelPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.match.test(id));
}

/**
 * The model's REAL input ceiling: the preset figure, or the mainstream
 * default. This is what the entry declares.
 */
export function realInputCeiling(model: string): number {
  return detectModelPreset(model)?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
}

/**
 * The input figure the SUMMARY lines show (settings mirror, manager list):
 * the model's real ceiling until the user overrides it, then their number.
 *
 * Identical to the resolved value now that the ladder is gone — kept as a
 * separate name so the summary keeps its own meaning ("what this model is"),
 * independent of what the declaration happens to be.
 */
export function summaryInputTokens(profile: Pick<Profile, 'model' | 'maxInputTokens'>): number {
  return profile.maxInputTokens > 0 ? profile.maxInputTokens : realInputCeiling(profile.model);
}

/** The one configured model, limits resolved (what the picker and the request path see). */
export interface ModelEntry extends ModelLimits {
  /** Sent as `model` in the request body AND shown in the picker. */
  readonly id: string;
  /** The preset that supplied the limits, if any (wizard summary / docs). */
  readonly presetLabel?: string;
}

/** Shared output channel ("Custom for Copilot Chat") for diagnostics that must survive without a debugger. */
let channel: vscode.OutputChannel | undefined;
export function modelOutput(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Custom for Copilot Chat');
  return channel;
}

// --- Profiles: one entry = one endpoint + one model + one key -------------------
//
// A profile is the unit the wizard creates. Several can coexist — that is the
// whole point: two gateways, or the same gateway with two keys — and each one
// shows up in the model picker under its own ALIAS (`name`).
//
// The picker id MUST be unique per profile, not per model: two profiles may
// serve the same upstream model id, and VS Code indexes the model list BY ID
// (a duplicate id means the second row silently replaces the first). Hence
// `<profileKey>::<model>` on the wire, decoded back on every request.

/** Separator inside a picker model id: `<profileKey>::<model>`. */
const PICKER_ID_SEPARATOR = '::';

/** One configured endpoint + model + (key stored in SecretStorage). */
export interface Profile {
  /** Internal, stable identifier — never shown, never reused. */
  readonly key: string;
  /** Display alias shown in the picker (empty = use the model id). */
  readonly name: string;
  /** API base URL, trailing slashes stripped. */
  readonly baseURL: string;
  /** The REAL `model` parameter sent in the request body. */
  readonly model: string;
  /**
   * This endpoint serves requests WITHOUT an API key.
   *
   * Self-hosted gateways are frequently keyless: a local inference server
   * started without an auth flag accepts — and ignores — whatever
   * Authorization header arrives. Requiring a key made those endpoints
   * impossible to add, so the wizard offers this as an explicit choice and no
   * Authorization header is sent at all (an empty `Bearer ` is accepted by
   * some of them but rejected by others, and it also trips auth middlewares
   * that treat the header's presence as a credential).
   */
  readonly noAuth?: boolean;
  /** Explicit input budget (`0` = auto: preset chain). */
  readonly maxInputTokens: number;
  /** Explicit output ceiling (`0` = auto: preset chain). */
  readonly maxOutputTokens: number;
}

/** Model id handed to VS Code: unique even when two profiles share a model. */
export function encodePickerId(profileKey: string, model: string): string {
  return `${profileKey}${PICKER_ID_SEPARATOR}${model}`;
}

/** Split a picker id back into its profile key and model. */
export function decodePickerId(
  pickerId: string
): { key: string; model: string } | undefined {
  const at = pickerId.indexOf(PICKER_ID_SEPARATOR);
  if (at <= 0 || at >= pickerId.length - PICKER_ID_SEPARATOR.length) {
    return undefined;
  }
  return {
    key: pickerId.slice(0, at),
    model: pickerId.slice(at + PICKER_ID_SEPARATOR.length),
  };
}

/** A fresh, collision-resistant profile key (`p` + timestamp + random). */
export function newProfileKey(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Normalise what the user typed as a base URL.
 *
 * Two things bite on a self-hosted / hosted OpenAI-compatible endpoint:
 *
 *   1. a FULL endpoint pasted in (`https://x/v1/chat/completions`) instead of
 *      its base — the request path appends `/chat/completions`, so that URL
 *      becomes `.../chat/completions/chat/completions` and answers 404, which
 *      the 400-only recovery ladder never retries;
 *   2. trailing slashes, which produce `//chat/completions` (accepted by most
 *      gateways, rejected by a few strict routers).
 *
 * `/v1` is deliberately NOT appended or verified: the correct prefix differs
 * per gateway (`/v1`, `/v1/openai`, `/openai/v1`, a deployment path, …) and
 * guessing it would break the ones that do not use `/v1`. Stripping only a
 * well-known SUFFIX is safe in both directions.
 */
export function normalizeBaseURL(input: string): string {
  let url = input.trim();
  // `.../chat/completions` is the endpoint, not the base — drop it. Case and
  // trailing slashes are tolerated because the two forms arrive from copied
  // curl snippets and docs pages.
  url = url.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return url.replace(/\/+$/, '');
}

/** A profile is usable when its endpoint needs no key, or its key is stored. */
export function profileHasCredentials(profile: Profile, apiKey: string): boolean {
  return profile.noAuth === true || apiKey.length > 0;
}

/**
 * Validate ONE stored row into a Profile. Unknown fields are dropped, empty
 * `key`/`model`/`baseURL` invalidate the row, and the two limits collapse to
 * `0` (= auto) unless they are positive finite numbers.
 *
 * Exported because the list lives in the user-level credential store
 * (`profileStore.ts`) and the stored payload is the single shape this parser
 * serves.
 */
export function parseProfile(raw: unknown): Profile | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const key = text(record.key);
  const model = text(record.model);
  const baseURL = normalizeBaseURL(text(record.baseURL));
  if (!key || !model || !baseURL) {
    return undefined;
  }
  const limit = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return {
    key,
    name: text(record.name),
    baseURL,
    model,
    // Only the explicit `true` counts: a hand-edited payload saying
    // `"noAuth": "false"` must not silently disable authentication.
    ...(record.noAuth === true ? { noAuth: true } : {}),
    maxInputTokens: limit(record.maxInputTokens),
    maxOutputTokens: limit(record.maxOutputTokens),
  };
}

// The list itself (read/write/upsert/remove + cross-window reload) lives in
// `profileStore.ts`: it is stored in the user-level credential store so every
// VS Code profile on the machine shares one set of groups.

/** Limits of one profile, resolved through the preset chain. */
export function resolveProfileEntry(profile: Profile): ModelEntry {
  const preset = detectModelPreset(profile.model);
  return {
    id: profile.model,
    // A hand-set value is kept verbatim; otherwise the model's real window is
    // declared as-is. Both harnesses read this one number, and neither offers a
    // control for it (see the module docblock for why).
    maxInputTokens:
      profile.maxInputTokens > 0 ? profile.maxInputTokens : realInputCeiling(profile.model),
    maxOutputTokens:
      profile.maxOutputTokens > 0
        ? profile.maxOutputTokens
        : preset?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    reasoning: preset?.reasoning ?? false,
    ...(preset ? { presetLabel: preset.label } : {}),
  };
}

/** SecretStorage key holding one profile's API key. */
export function apiKeySecretKey(profileKey: string): string {
  return `customModel.apiKey.${profileKey}`;
}

/** The API key of ONE profile; empty = that profile is not configured. */
export async function readProfileApiKey(
  context: vscode.ExtensionContext,
  profile: Profile
): Promise<string> {
  return (await context.secrets.get(apiKeySecretKey(profile.key)))?.trim() ?? '';
}

/** Store (or clear) one profile's API key in SecretStorage. */
export async function writeProfileApiKey(
  context: vscode.ExtensionContext,
  profileKey: string,
  value: string
): Promise<void> {
  const key = apiKeySecretKey(profileKey);
  const trimmed = value.trim();
  if (trimmed) {
    await context.secrets.store(key, trimmed);
  } else {
    await context.secrets.delete(key);
  }
}

/**
 * Rough token figure for a label: 96000 → `94K`, 65536 → `64K`,
 * 1048576 → `1M`. The M step matters — "1024K" is not what anyone picks a
 * window by, and the summary lines that print an output ceiling use this.
 *
 * Binary on purpose: the figures this labels ARE binary (65536 is 64K).
 */
export function tokenWindowLabel(tokens: number): string {
  return tokens >= 1048576 ? `${Math.round(tokens / 1048576)}M` : `${Math.round(tokens / 1024)}K`;
}

/**
 * Label for a SUMMARIZED figure, in the vendor's decimal notation:
 * 200000 → `200K`, 128000 → `128K`, 1048576 → `1M`.
 *
 * Not {@link tokenWindowLabel}: preset ceilings are quoted in decimal (a
 * 200K window), and dividing them by 1024 prints 195K — a number that
 * matches nothing the user has read anywhere.
 */
export function summaryWindowLabel(tokens: number): string {
  return tokens >= 1000000 ? `${Math.round(tokens / 1000000)}M` : `${Math.round(tokens / 1000)}K`;
}



// --- Fixed behavior (no settings — behavior lives in code, not options) ---------

/**
 * `max_tokens` cap for Copilot helper requests (chat titles, commit messages,
 * todo tracking…): a helper answers in a sentence, and without the cap it
 * would generate up to the model's full output ceiling on every title.
 */
export const UTILITY_MAX_OUTPUT_TOKENS = 2048;

export type ThinkingDisableStyle = 'none' | 'thinking-disabled' | 'chat_template_kwargs' | 'enable_thinking' | 'openai';

/**
 * Fixed at `none`: helper requests are NOT asked to stop thinking. There is
 * no cross-vendor spelling for "do not think", and sending a parameter the
 * gateway does not know costs a wasted round-trip (the 400-retry ladder then
 * strips it anyway).
 */
export const THINKING_DISABLE_STYLE: ThinkingDisableStyle = 'none';

/**
 * One position of the THINKING-EFFORT gear — the dropdown the model picker
 * renders in its configuration panel.
 *
 * TWO harnesses read this dropdown, and they do NOT read it the same way:
 *
 *   - VS Code's own picker renders `configurationSchema` (group `navigation`);
 *   - Copilot's harness ignores that schema and builds its own dropdown from
 *     the TOP-LEVEL `supportsReasoningEffort` / `defaultReasoningEffort`
 *     fields — and it labels every entry through a FIXED table
 *     (`none / minimal / low / medium / high / xhigh / max`). A value outside
 *     that table is DROPPED silently, which is how this extension ended up
 *     showing five positions in one window and four in the other.
 *
 * So the ids ARE the host's words, and both windows then show the same list.
 * `none` is the position that sends NOTHING: an arbitrary OpenAI-compatible
 * gateway has no single spelling for "how hard to think" — or even for "do not
 * think" (see {@link THINKING_DISABLE_STYLE}) — so the safe default is to let
 * the gateway's own rule stand. `low` / `medium` / `high` go out verbatim as
 * `reasoning_effort`, and a gateway that rejects the parameter has it removed
 * by the 400 ladder (`reasoning_effort` is already one of the optional body
 * params) instead of failing the request.
 *
 * Localised wording lives in the panel's `enumItemLabels` (which only VS Code's
 * picker reads) — NEVER in the id, because the id is what Copilot filters on.
 *
 * Deliberate trade-off: `reasoning_effort: "none"` is no longer ever sent. One
 * of the four visible positions had to carry "send nothing" (the host has no
 * word for it), and putting it on `none` is the only mapping where the label
 * still tells the truth. A gateway that needs the literal value to stop
 * thinking is better served by `low`.
 */
export type ThinkingEffort = 'none' | 'low' | 'medium' | 'high';

/** Gear positions in dropdown order — the default first. */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['none', 'low', 'medium', 'high'];

/** Position applied when the host sends no (or an unknown) choice. */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'none';

/**
 * The RETIRED id of the no-parameter position: builds before the rungs were
 * named after the host's words offered `auto`. VS Code keeps the value it
 * stored, so `auto` has to keep meaning "send nothing" rather than degrading
 * to whatever the default happens to be.
 */
const RETIRED_NO_PARAM_EFFORT = 'auto';

/**
 * Narrow a gear value: an unknown id (a stale stored value, an older host)
 * falls back to the default instead of failing the request.
 */
export function resolveThinkingEffort(value: string | undefined): ThinkingEffort {
  const normalized = value?.trim().toLowerCase();
  if (normalized === RETIRED_NO_PARAM_EFFORT) {
    return 'none';
  }
  return THINKING_EFFORTS.find((effort) => effort === normalized) ?? DEFAULT_THINKING_EFFORT;
}

/**
 * The `reasoning_effort` value for the wire, or `undefined` for the position
 * that asks for nothing.
 */
export function thinkingEffortParam(effort: ThinkingEffort): string | undefined {
  return effort === 'none' ? undefined : effort;
}
