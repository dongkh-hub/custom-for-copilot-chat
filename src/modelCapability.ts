/**
 * LEARNED CAPABILITIES — which `reasoning_effort` values a given
 * (endpoint, model) pair actually ACCEPTS.
 *
 * WHY. `reasoning_effort` is a de-facto standard field whose VALUE SET is not
 * standard at all: `medium` is a 400 on one self-hosted gateway, but maps
 * silently to `high` on another; one endpoint accepts only `low/high/max`
 * and rejects everything else; another has no `none` at all. There is no probe
 * endpoint and no honest capability document, so the only source of truth is
 * what the gateway ACTUALLY answered last time.
 *
 * WHAT THIS MODULE DOES. It is the memory half of the request path's 400
 * recovery: the provider retries without the rejected parameter (see
 * applyCompatibilityFallback in message.ts), and on a clean, attributable
 * retry it tells this module "value X was refused for this pair". From then
 * on:
 *   - {@link effortVerdict} answers synchronously (in-memory cache), so the
 *     request path can substitute a safe value BEFORE spending a round-trip;
 *   - the gear panel annotates the refused position instead of offering it as
 *     if it worked.
 *
 * STORAGE. `context.secrets` under `customModel.capabilities.v1` — the same
 * APPLICATION-scoped store the profile list uses, so what one VS Code profile
 * learns, every VS Code profile (and every window) knows. The payload holds
 * the endpoint HOST + path and the model id, never a key, never a header.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It never probes on activation. A wrong value costs one extra round-trip
 *     on the message that used it, and nothing at all afterwards.
 *   - It never generalises from ONE parameter to another. A 400 that names no
 *     field, healed by dropping six optional parameters at once, proves
 *     nothing about the effort — that case is NOT recorded (see the caller).
 *   - It never forgets on its own schedule: a gateway upgrade can widen the
 *     accepted set, and a stale "rejected" would then silently downgrade a
 *     value that works. {@link clearCapabilities} (a command) is the undo.
 */
import * as vscode from 'vscode';
import { THINKING_EFFORTS, modelOutput, type ThinkingEffort } from './config';

/** Verdict for one (endpoint, model, effort) triple. */
export type EffortVerdict = 'supported' | 'rejected' | 'unknown';

/**
 * SecretStorage slot. Versioned so a future shape change can migrate instead
 * of guessing at an unknown payload.
 */
export const CAPABILITY_SECRET_KEY = 'customModel.capabilities.v1';

/** What is remembered about ONE (endpoint, model) pair. */
interface ModelRecord {
  /** Values this pair answered 400 to (lowercased wire values). */
  rejectedEfforts: string[];
  /**
   * The full accepted set, ONLY when the error body enumerated it ("must be
   * one of low, high, max"). Absent when we merely know one value is bad.
   */
  supportedEfforts?: string[];
  /** The gateway refuses `reasoning_effort` as a field, whatever the value. */
  fieldUnsupported?: boolean;
  /** ISO timestamp of the last change — the LRU eviction key. */
  learnedAt: string;
}

interface Payload {
  version: 1;
  models: Record<string, ModelRecord>;
}

/**
 * Ceiling on remembered pairs. A user with a handful of gateways needs a
 * dozen at most; the limit exists so a script cycling model ids cannot grow
 * the secret without bound. Oldest entry is dropped first.
 */
const MAX_RECORDS = 64;

/** Application-scoped store, set by {@link initCapabilityStore}. */
let store: vscode.SecretStorage | undefined;

let cache: Payload = { version: 1, models: {} };

/** Serialized payload last read/written — skips no-op writes. */
let lastPayload = '';

/** Values the wire recognises; anything else is not a gear position. */
const KNOWN_EFFORTS = new Set<string>(THINKING_EFFORTS);

/**
 * Read the payload once. NEVER throws: a host without a working SecretStorage
 * degrades to "nothing learned yet", which is exactly the pre-module
 * behaviour (every request goes to the 400 ladder).
 */
export async function initCapabilityStore(context: vscode.ExtensionContext): Promise<void> {
  store = context.secrets;
  try {
    const raw = await store.get(CAPABILITY_SECRET_KEY);
    if (!raw) {
      cache = { version: 1, models: {} };
      lastPayload = '';
      return;
    }
    cache = parsePayload(raw);
    lastPayload = raw;
  } catch (err) {
    modelOutput().appendLine(`[capability] credential store unavailable — ${String(err)}`);
    store = undefined;
  }
}

function parsePayload(raw: string): Payload {
  try {
    const parsed = JSON.parse(raw) as Partial<Payload>;
    if (!parsed || parsed.version !== 1 || typeof parsed.models !== 'object' || parsed.models === null) {
      return { version: 1, models: {} };
    }
    const models: Record<string, ModelRecord> = {};
    for (const [key, value] of Object.entries(parsed.models)) {
      const record = value as Partial<ModelRecord>;
      const rejected = Array.isArray(record.rejectedEfforts)
        ? record.rejectedEfforts.filter((item): item is string => typeof item === 'string')
        : [];
      const supported = Array.isArray(record.supportedEfforts)
        ? record.supportedEfforts.filter((item): item is string => typeof item === 'string')
        : undefined;
      models[key] = {
        rejectedEfforts: rejected,
        ...(supported && supported.length > 0 ? { supportedEfforts: supported } : {}),
        ...(record.fieldUnsupported === true ? { fieldUnsupported: true } : {}),
        learnedAt: typeof record.learnedAt === 'string' ? record.learnedAt : new Date(0).toISOString(),
      };
    }
    return { version: 1, models };
  } catch {
    return { version: 1, models: {} };
  }
}

/**
 * Identity of an ENDPOINT for learning purposes: host + path, no scheme, no
 * trailing slash, lowercased. Two profiles pointing at the same gateway share
 * what they learn; `https` vs `http` does not fork it (a gateway that answers
 * 400 does so for both).
 */
export function endpointKey(baseURL: string): string {
  const trimmed = baseURL.trim();
  try {
    const url = new URL(trimmed);
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/** The record key: endpoint FIRST so an endpoint's models stay contiguous. */
function recordKey(baseURL: string, model: string): string {
  return `${endpointKey(baseURL)}|${model.trim().toLowerCase()}`;
}

/**
 * What is known about ONE gear position. The position that asks for nothing
 * (`none`, and the retired `auto` spelling of it) is always "supported" — it
 * puts nothing on the wire, so there is nothing a gateway could reject.
 */
export function effortVerdict(baseURL: string, model: string, effort: string): EffortVerdict {
  if (effort === 'none' || effort === 'auto') {
    return 'supported';
  }
  const record = cache.models[recordKey(baseURL, model)];
  if (!record) {
    return 'unknown';
  }
  if (record.rejectedEfforts.includes(effort)) {
    return 'rejected';
  }
  if (record.supportedEfforts) {
    return record.supportedEfforts.includes(effort) ? 'supported' : 'rejected';
  }
  return record.fieldUnsupported ? 'rejected' : 'unknown';
}

/**
 * The value to send INSTEAD of a known-bad one, or `undefined` when nothing
 * safe is known. `high` first: it is the one position accepted by every
 * gateway measured so far; `low` second. `auto` (drop the parameter
 * entirely) is the caller's last resort, not a value returned here.
 */
export function fallbackEffort(baseURL: string, model: string): ThinkingEffort | undefined {
  for (const candidate of ['high', 'low'] as const) {
    if (effortVerdict(baseURL, model, candidate) !== 'rejected') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Record what the gateway just told us.
 *
 * `rejected` is only ever called from an ATTRIBUTABLE failure: the retry that
 * succeeded differed by removing the effort alone (the caller enforces that).
 * `detail` is the gateway's error body, used for the one thing worth parsing —
 * an enumerated accepted set.
 */
export async function recordEffortVerdict(
  baseURL: string,
  model: string,
  effort: string,
  verdict: 'supported' | 'rejected',
  detail?: string
): Promise<boolean> {
  const value = effort.trim().toLowerCase();
  if (!KNOWN_EFFORTS.has(value) || value === 'none' || value === 'auto') {
    return false; // nothing goes on the wire for that position — nothing to learn
  }
  const key = recordKey(baseURL, model);
  const record: ModelRecord = cache.models[key] ?? {
    rejectedEfforts: [],
    learnedAt: new Date().toISOString(),
  };
  let changed = false;

  if (verdict === 'rejected') {
    if (!record.rejectedEfforts.includes(value)) {
      record.rejectedEfforts.push(value);
      changed = true;
    }
    const enumerated = parseSupportedFromDetail(detail, value);
    if (enumerated) {
      if (!sameSet(record.supportedEfforts, enumerated)) {
        record.supportedEfforts = enumerated;
        changed = true;
      }
      // An enumerated set supersedes guesswork: drop contradictions.
      const before = record.rejectedEfforts.length;
      record.rejectedEfforts = record.rejectedEfforts.filter((item) => !enumerated.includes(item));
      changed = changed || record.rejectedEfforts.length !== before;
    } else if (record.rejectedEfforts.length >= 3 && !record.supportedEfforts) {
      // Three distinct refusals and no list of what IS accepted: the endpoint
      // is refusing the FIELD, not the value. Marking it stops the request
      // path from probing a fourth position that cannot work.
      record.fieldUnsupported = true;
      changed = true;
    }
  } else {
    const before = record.rejectedEfforts.length;
    record.rejectedEfforts = record.rejectedEfforts.filter((item) => item !== value);
    changed = changed || record.rejectedEfforts.length !== before;
    if (record.supportedEfforts && !record.supportedEfforts.includes(value)) {
      record.supportedEfforts = undefined;
      changed = true;
    }
    if (record.fieldUnsupported) {
      record.fieldUnsupported = false;
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }
  record.learnedAt = new Date().toISOString();
  cache.models[key] = record;
  evictOldest();
  await persist();
  return true;
}

/**
 * Pull the accepted set out of an error body, but ONLY when it is spelled out
 * as a list ("must be one of low, high, max"). A gateway that answers with a
 * generic body yields nothing: guessing an accepted set from prose is how a
 * one-off error becomes a permanent, wrong conclusion.
 *
 * `sent` is excluded from the result — the rejected value often appears in the
 * same sentence as the accepted ones.
 */
export function parseSupportedFromDetail(detail: string | undefined, sent: string): string[] | undefined {
  if (!detail || !/reasoning[_\s-]?effort/i.test(detail)) {
    return undefined;
  }
  const window = /(?:one of|must be|allowed|supported|valid|expected|accepts?)[^.;]{0,160}/i.exec(detail);
  if (!window) {
    return undefined;
  }
  const found = new Set<string>();
  for (const match of window[0].matchAll(/\b(none|minimal|low|medium|high|xhigh|max|ultra)\b/gi)) {
    found.add(match[1].toLowerCase());
  }
  found.delete(sent);
  if (found.size < 2) {
    return undefined;
  }
  // Wire order, so a stored set reads predictably in the log.
  const ordered: string[] = THINKING_EFFORTS.filter((item) => found.has(item));
  for (const item of found) {
    if (!ordered.includes(item)) {
      ordered.push(item);
    }
  }
  return ordered;
}

function sameSet(left: string[] | undefined, right: string[]): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

/** Drop the least-recently-learned pair once the cap is exceeded. */
function evictOldest(): void {
  const keys = Object.keys(cache.models);
  if (keys.length <= MAX_RECORDS) {
    return;
  }
  keys
    .sort((a, b) => cache.models[a].learnedAt.localeCompare(cache.models[b].learnedAt))
    .slice(0, keys.length - MAX_RECORDS)
    .forEach((key) => {
      delete cache.models[key];
    });
}

async function persist(): Promise<void> {
  const payload = JSON.stringify(cache);
  if (payload === lastPayload) {
    return; // nothing actually changed — do not churn SecretStorage
  }
  lastPayload = payload;
  if (!store) {
    return; // memory-only degradation
  }
  try {
    await store.store(CAPABILITY_SECRET_KEY, payload);
  } catch (err) {
    lastPayload = '';
    modelOutput().appendLine(`[capability] not persisted — ${String(err)}`);
  }
}

/** Forget everything (the escape hatch after a gateway upgrade). */
export async function clearCapabilities(): Promise<number> {
  const count = Object.keys(cache.models).length;
  cache = { version: 1, models: {} };
  lastPayload = '';
  if (store) {
    try {
      await store.delete(CAPABILITY_SECRET_KEY);
    } catch (err) {
      modelOutput().appendLine(`[capability] clear failed — ${String(err)}`);
    }
  }
  return count;
}

/** How many pairs are remembered (the status message after a clear). */
export function rememberedCount(): number {
  return Object.keys(cache.models).length;
}

/**
 * One line for the output channel, e.g.
 * `my-model @ gw.example.com/v1: rejected=medium, accepted=low/high/max`.
 * Returns undefined when nothing is known about the pair.
 */
export function describeVerdict(baseURL: string, model: string): string | undefined {
  const record = cache.models[recordKey(baseURL, model)];
  if (!record) {
    return undefined;
  }
  const parts: string[] = [];
  if (record.fieldUnsupported) {
    parts.push('field unsupported');
  }
  if (record.rejectedEfforts.length > 0) {
    parts.push(`rejected=${record.rejectedEfforts.join('/')}`);
  }
  if (record.supportedEfforts) {
    parts.push(`accepted=${record.supportedEfforts.join('/')}`);
  }
  return parts.length > 0
    ? `${endpointKey(baseURL)}: ${model} → ${parts.join(', ')}`
    : undefined;
}
