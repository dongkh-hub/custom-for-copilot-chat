/**
 * Configuration surface: the profile SHAPE, state keys, official model presets
 * and the thinking-effort gear.
 *
 * The configured list itself does NOT live here — `profileStore.ts` owns it,
 * in the user-level credential store (`customModel.profiles.v2`), so every VS
 * Code profile on this machine sees the same groups. This module owns what a
 * group IS ({ key, name, baseURL, model, noAuth?, maxInputTokens,
 * maxOutputTokens }) and everything derived from it: the official preset
 * chain, the picker id encoding, the context-window rungs and the
 * thinking-effort gear. API keys stay in SecretStorage too, under
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
 * ...and the INPUT side has one extra step: unless it was hand-set, the
 * resolved window snaps DOWN onto the fixed context ladder
 * ({@link CONTEXT_WINDOW_TIERS}), so the declared budget is always a rung the
 * gear panel can show as its own default. The ladder is the same for every
 * model — the preset only decides WHICH rung a model starts on
 * ({@link defaultContextTier}).
 *
 * `0` (the default) means "auto": the preset chain rules. Everything else
 * this extension does (helper-request downgrade, tool-list stabilization,
 * thinking passthrough) is fixed behavior — there are no hidden switches.
 *
 * The preset REGEXES recognize the ids of mainstream models so their limits
 * apply automatically; the preset ids/labels stay neutral (alpha/beta/gamma)
 * so nothing vendor-specific surfaces in the wizard summary or docs. There
 * is NO universal input:output ratio — each model caps output per id, and
 * reasoning models keep their own (larger) output budget because reasoning
 * tokens count toward it. When a gateway serves ids no preset recognizes,
 * the mainstream default applies and the gear panel can pin real numbers.
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
   * Always a rung of {@link CONTEXT_WINDOW_TIERS} unless the user set one by
   * hand (the gear panel writes its pick back into the profile verbatim).
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
 * default — taken BEFORE the ladder snaps it onto a rung.
 */
export function realInputCeiling(model: string): number {
  return detectModelPreset(model)?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
}

/**
 * The input figure the SUMMARY lines show (settings mirror, manager list):
 * the model's real ceiling until the user overrides it, then their number.
 *
 * Deliberately NOT the resolved value: a rung is a BUDGET, so printing `128K`
 * for a 200K model would read as "that is all it can do". The rung is what
 * the gear panel STARTS that model on, not its window.
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
    // A hand-set value (a rung picked in the gear panel, or a hand-typed
    // number) is kept verbatim; the preset's real window otherwise snaps DOWN
    // onto the ladder, so the declared window is always a rung the gear panel
    // can show as its own `default`.
    maxInputTokens:
      profile.maxInputTokens > 0
        ? profile.maxInputTokens
        : defaultContextTier(realInputCeiling(profile.model)),
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
 * window by, and the gear panel's own ladder label has to match the summary
 * lines that show the same number.
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
 * matches nothing the user has read anywhere. Rungs stay on the binary
 * label because 131072 IS 128K.
 */
export function summaryWindowLabel(tokens: number): string {
  return tokens >= 1000000 ? `${Math.round(tokens / 1000000)}M` : `${Math.round(tokens / 1000)}K`;
}

/**
 * The context-window ladder: ONE fixed set of rungs for EVERY model, ASCENDING
 * (64K up to 1M) — this is the order the gear panel renders them in.
 *
 * The rungs are deliberately NOT derived from the model. A ladder derived
 * from the ceiling collapsed on the first pick — choose 512K of 1M and the
 * 1M rung disappeared — and one derived from the currently effective value
 * could never offer anything above it. A fixed ladder has neither problem,
 * and it is the same ladder everywhere, so what the user learns once applies
 * to every model they add later.
 *
 * 64K is the floor: the host spends part of the budget on the answer, and a
 * vendor's round figure (128000) is not the whole window, so the smallest
 * rung has to leave room under a 128K model.
 *
 * Everything that reads this array must stay order-agnostic: the ladder is
 * ASCENDING, so the smallest rung is `[0]` and the fitting rung of
 * `defaultContextTier` is the LAST one, not the first.
 */
export const CONTEXT_WINDOW_TIERS: readonly number[] = [
  65536, 131072, 262144, 524288, 1048576,
];

/**
 * How far a rung may exceed a real ceiling and still count as fitting (8K).
 * Preset figures are round decimal — 128000 for a 128K window, 1047576 for a
 * 1M one — and without the slack those would snap a whole rung down over a
 * few KB of rounding.
 */
const TIER_FIT_SLACK = 8192;

/**
 * The rungs offered for ONE model: the fixed ladder, plus the model's
 * currently effective value when that is not already a rung.
 *
 * The extra member is what keeps a HAND-TYPED window reachable: the schema's
 * `default` is the effective value, and a default that is not a member of its
 * own enum leaves the host with an empty dropdown. It is slotted in by VALUE
 * (the ladder is ascending), not appended — a hand-set 700K between two rungs
 * must not read as "bigger than 1M".
 */
export function contextTierOptions(current?: number): readonly { tokens: number; label: string }[] {
  const tokens = CONTEXT_WINDOW_TIERS.filter((tier) => tier !== current);
  if (current !== undefined && current > 0) {
    tokens.push(current);
    tokens.sort((left, right) => left - right);
  }
  return tokens.map((value) => ({ tokens: value, label: tokenWindowLabel(value) }));
}

/**
 * The rung a model STARTS on: the largest rung that does not exceed its real
 * window. A model below the smallest rung still gets the smallest one —
 * declaring a budget UNDER the real window only costs context (the host
 * compacts earlier), while one over it costs a failed request.
 */
export function defaultContextTier(realCeiling: number): number {
  const fitting = CONTEXT_WINDOW_TIERS.filter((tier) => tier <= realCeiling + TIER_FIT_SLACK);
  // The ladder is ascending, so the largest fitting rung is the LAST one and
  // the floor is the FIRST one.
  return fitting[fitting.length - 1] ?? CONTEXT_WINDOW_TIERS[0];
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
 * renders from `configurationSchema` (the same non-public contract the
 * official Auto selector and the built-in reasoning-effort dropdown ride on).
 *
 * `auto` is the default and sends NOTHING. An arbitrary OpenAI-compatible
 * gateway has no single spelling for "how hard to think" — or even for "do
 * not think" (see {@link THINKING_DISABLE_STYLE}) — so the safe default is to
 * let the gateway's own rule stand. Every other value goes out verbatim as
 * `reasoning_effort`, and a gateway that rejects the parameter has it removed
 * by the 400 ladder (`reasoning_effort` is already one of the optional body
 * params) instead of failing the request.
 */
export type ThinkingEffort = 'auto' | 'none' | 'low' | 'medium' | 'high';

/** Gear positions in dropdown order — the default first. */
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['auto', 'none', 'low', 'medium', 'high'];

/** Position applied when the host sends no (or an unknown) choice. */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'auto';

/**
 * Narrow a gear value: an unknown id (a stale stored value, an older host)
 * falls back to the default instead of failing the request.
 */
export function resolveThinkingEffort(value: string | undefined): ThinkingEffort {
  const normalized = value?.trim().toLowerCase();
  return THINKING_EFFORTS.find((effort) => effort === normalized) ?? DEFAULT_THINKING_EFFORT;
}

/** The `reasoning_effort` value for the wire, or `undefined` for `auto`. */
export function thinkingEffortParam(effort: ThinkingEffort): string | undefined {
  return effort === 'auto' ? undefined : effort;
}
