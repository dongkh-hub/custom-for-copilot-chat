/**
 * Reasoning replay across turns — the fix for "the second round 400s".
 *
 * WHY THIS EXISTS
 * ---------------
 * A thinking model answers with two streams: `reasoning_content` (the chain of
 * thought) and `content` (the answer). On every LATER turn reasoning-aware
 * gateways expect the reasoning of the previous assistant turn to be handed
 * back with it — for a turn that called tools it is effectively mandatory, and
 * even where it is optional the missing prefix destroys prompt-cache hits (the
 * cached prefix no longer matches byte for byte).
 *
 * The host, however, does NOT reliably give the reasoning back to us:
 * `LanguageModelThinkingPart` is a PROPOSED API, absent on older builds, and
 * whether a streamed thinking part survives into the next request's message
 * list depends on the build and on session restore. So a provider that only
 * reads thinking parts back ends up sending assistant messages with NO
 * `reasoning_content` from the second round on — exactly the shape a strict
 * gateway rejects with a generic 400 that names no field.
 *
 * THE MECHANISM
 * -------------
 * We attach the reasoning text to our own response as a `LanguageModelDataPart`
 * with a private MIME type. Data parts are opaque to the host: it stores and
 * replays them verbatim in the next request's message content, which is the
 * same channel images travel through. On the next turn we read that part back
 * and use it as `reasoning_content`, which
 *
 *   - restores the chain of thought the gateway is owed,
 *   - keeps the prompt prefix identical between turns (cache hits), and
 *   - survives a window reload, because it lives in the stored transcript
 *     rather than in extension memory.
 *
 * The marker outranks a thinking part when both are present — it is the exact
 * text the gateway produced; thinking parts serve only when the marker is
 * absent (e.g. after the host dropped it).
 *
 * FAILURE MODE: on a host that does not replay unknown data parts the marker
 * simply never comes back (`readReasoningMarker` returns undefined) and this
 * module is a no-op — no regression, just no gain.
 */
import * as vscode from 'vscode';

/**
 * Private MIME type for our marker. Deliberately the same string the
 * built-in reasoning provider uses: the host treats data-part MIME types as
 * opaque, and a value that already survives round-trips in the wild is the
 * safest choice.
 */
export const REPLAY_MARKER_MIME = 'stateful_marker';

/** Identifies the payload as ours (another provider's marker must be ignored). */
const MARKER_WRITER_ID = 'custom-for-copilot-chat';

/** Marks the payload as base64url-encoded JSON (`json:` prefix on the wire). */
const ENCODED_JSON_PREFIX = 'json:';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Data parts are absent on older hosts (`LanguageModelDataPart` was added
 * later); resolve the class at runtime instead of touching it directly.
 */
function dataPartClass(): typeof vscode.LanguageModelDataPart | undefined {
  const candidate = (vscode as unknown as Record<string, unknown>).LanguageModelDataPart;
  return typeof candidate === 'function'
    ? (candidate as typeof vscode.LanguageModelDataPart)
    : undefined;
}

/**
 * The marker part carrying `text` as this turn's reasoning, or `undefined`
 * when the host cannot carry one (older build) or there is nothing to replay.
 *
 * Reported at the END of the stream: the reasoning is only complete then, and
 * a host that sees the part mid-stream would still store the final list.
 */
export function createReasoningMarker(text: string): vscode.LanguageModelDataPart | undefined {
  if (!text) {
    return undefined;
  }
  const ctor = dataPartClass();
  if (!ctor) {
    return undefined;
  }
  const payload = `${ENCODED_JSON_PREFIX}${Buffer.from(
    JSON.stringify({ reasoning: { text } }),
    'utf8'
  ).toString('base64url')}`;
  try {
    return new ctor(new TextEncoder().encode(`${MARKER_WRITER_ID}\\${payload}`), REPLAY_MARKER_MIME);
  } catch {
    // A host that rejects the MIME type must not fail the response.
    return undefined;
  }
}

/**
 * Reasoning text stored on an earlier assistant turn, or `undefined`.
 *
 * Returns `undefined` (never throws) for anything that is not OUR marker: a
 * different writer id, a malformed payload, an empty text, or a part the host
 * did not replay.
 */
export function readReasoningMarker(content: readonly unknown[]): string | undefined {
  for (const part of content) {
    const text = parseMarkerPart(part);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function parseMarkerPart(part: unknown): string | undefined {
  if (!isOurMarkerPart(part)) {
    return undefined;
  }
  const data = (part as { data?: unknown }).data;
  if (!(data instanceof Uint8Array)) {
    return undefined;
  }
  try {
    const decoded = new TextDecoder().decode(data);
    const separator = decoded.indexOf('\\');
    if (separator < 0 || decoded.slice(0, separator) !== MARKER_WRITER_ID) {
      return undefined;
    }
    const json = decodePayload(decoded.slice(separator + 1));
    if (!json) {
      return undefined;
    }
    const value = JSON.parse(json) as { reasoning?: { text?: unknown } };
    const text = value?.reasoning?.text;
    return typeof text === 'string' && text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** `json:<base64url>` (current writer) or a raw JSON payload (tolerant read). */
function decodePayload(payload: string): string | undefined {
  if (!payload.startsWith(ENCODED_JSON_PREFIX)) {
    return payload.startsWith('{') ? payload : undefined;
  }
  const encoded = payload.slice(ENCODED_JSON_PREFIX.length);
  if (!encoded || !BASE64URL_PATTERN.test(encoded)) {
    return undefined;
  }
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/**
 * True when the part is a data part with our MIME type. MIME is checked FIRST
 * because a foreign marker (another extension's) must never be decoded.
 */
function isOurMarkerPart(part: unknown): boolean {
  const ctor = dataPartClass();
  if (!ctor || !(part instanceof ctor)) {
    return false;
  }
  return (part as { mimeType?: unknown }).mimeType === REPLAY_MARKER_MIME;
}
