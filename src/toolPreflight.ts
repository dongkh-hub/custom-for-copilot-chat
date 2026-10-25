/**
 * `activate_*` tool preflight — finish VS Code's tool-activation handshake.
 *
 * Newer Copilot Chat builds (and the Agents window's Copilot SDK runtime) do
 * not hand every tool to the model at once. Instead the tool list contains
 * `activate_<group>` entries and the model is expected to CALL them; only then
 * does VS Code expand the real tools into the next round. Two things go wrong
 * on a third-party provider:
 *
 *   1. the model never calls them, so the agent silently runs with no tools;
 *   2. the calls land in the transcript, and on the next round our own
 *      synthetic call/result pairs are still there — dead control flow that
 *      confuses the model and inflates every subsequent prompt.
 *
 * So this module:
 *
 *   - inspects the transcript for how many activation rounds already ran and
 *     which activators are still uncalled,
 *   - lets the provider emit the missing `activate_*` calls itself and return
 *     WITHOUT spending a single token (the biggest win: no request is sent),
 *   - strips its own synthetic call/result parts back out before a real
 *     request goes to the gateway.
 *
 * MEASURED HOST SEMANTICS: activator groups are MUTUALLY EXCLUSIVE, not
 * additive. Activating one group revokes the previously active one. Two
 * consequences drive the design:
 *
 *   - emitting every activator in one round leaves only the LAST group alive;
 *     we therefore emit exactly ONE per turn (pickActivatorToCall) and stop as
 *     soon as any activator was called,
 *   - `activate_*` entries never disappear from an expanded list, so their
 *     continued presence is the normal state, NOT an instability signal.
 *
 * The synthetic call ids are recognisable (`cm_preflight_activate_<round>_…`)
 * so we can tell our own control flow apart from VS Code's.
 *
 * ALWAYS ON (fixed behavior — no switch): the handshake
 * costs no gateway request, and without it a folded list leaves the agent
 * with zero tools.
 */
import { createHash } from 'crypto';
import * as vscode from 'vscode';

/** Copilot Chat's tool-activation prefix. */
export const ACTIVATE_TOOL_PREFIX = 'activate_';

/** Marks a call/result part as OUR synthetic activation handshake. */
const PREFLIGHT_CALL_ID_PREFIX = 'cm_preflight_activate_';
const CALL_ID_SEPARATOR = '_';
const TOOL_NAME_HASH_LENGTH = 32;

/**
 * Give up after this many activation rounds for one user turn. Without a cap a
 * list that never stabilizes would ping-pong forever — each round a full-price
 * gateway request.
 */
export const MAX_PREFLIGHT_ROUNDS = 3;

export interface ActivatePreflight {
  /** Rounds already completed for the current user turn (0 = none). */
  rounds: number;
  /** Activators called (by us or by the model) — before any of these the
   *  tool surface holds no real tools at all. */
  calledActivatorNames: string[];
  /** Activators advertised in this round but not called yet. */
  remainingActivatorNames: string[];
  /** Every activator advertised in this round, called or not. */
  activatorNames: string[];
  /**
   * Activation already happened and `activate_*` entries are STILL in the tool
   * list. Under the measured mutually-exclusive semantics this is the NORMAL
   * state (the host keeps the switches, only one group is live), so it is
   * reported for diagnostics and never retried.
   */
  activatorsStillAdvertised: boolean;
}

/**
 * How far the handshake has got, and what is still owed.
 *
 * Only parts AFTER the last genuine user message are inspected: activation
 * belongs to the current turn, and an older round's ids must not count.
 */
export function inspectActivatePreflight(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): ActivatePreflight {
  const activatorNames = collectActivateToolNames(tools);
  const calledActivatorNames = new Set<string>();
  let rounds = 0;

  const latestUserIndex = findLatestHumanUserMessageIndex(messages);
  for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
    for (const part of messages[index].content) {
      const parsed = parsePreflightPart(part);
      if (!parsed) {
        continue;
      }
      rounds = Math.max(rounds, parsed.round);
      if (parsed.toolName?.startsWith(ACTIVATE_TOOL_PREFIX)) {
        calledActivatorNames.add(parsed.toolName);
      }
    }
  }

  const remainingActivatorNames = activatorNames.filter((name) => !calledActivatorNames.has(name));
  return {
    rounds,
    calledActivatorNames: [...calledActivatorNames],
    remainingActivatorNames,
    activatorNames,
    // Only meaningful AFTER a call: before that the switches are expected to
    // sit there waiting. See the header note on exclusive groups.
    activatorsStillAdvertised:
      rounds > 0 && activatorNames.length > 0 && Boolean(tools?.length),
  };
}

/**
 * Which activator to call next — `undefined` once the handshake is done.
 *
 * Exactly ONE per turn, by design: groups are mutually exclusive on the host,
 * so a second call would revoke the group the first one just brought in.
 */
export function pickActivatorToCall(preflight: ActivatePreflight): string | undefined {
  if (preflight.calledActivatorNames.length > 0) {
    return undefined;
  }
  return preflight.remainingActivatorNames[0];
}

/** Real (non-activator) tools currently on the surface. */
export function countRealTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): number {
  return (tools ?? []).filter((tool) => !tool.name.startsWith(ACTIVATE_TOOL_PREFIX)).length;
}

/**
 * One-line description of the live tool surface, e.g.
 * `real=12 activators=3 groups=edit:4,terminal:3`.
 *
 * This is the only way to tell a working activation from a silent no-op: the
 * host gives no other feedback.
 */
export function summarizeToolSurface(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  maxGroups = 6
): string {
  const counts = new Map<string, number>();
  let activators = 0;
  for (const tool of tools ?? []) {
    if (tool.name.startsWith(ACTIVATE_TOOL_PREFIX)) {
      activators += 1;
      continue;
    }
    const separator = tool.name.indexOf('_');
    const group = separator > 0 ? tool.name.slice(0, separator) : tool.name;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxGroups)
    .map(([group, count]) => `${group}:${count}`)
    .join(',');
  const real = countRealTools(tools);
  return `real=${real} activators=${activators}${groups ? ` groups=${groups}` : ''}`;
}

/**
 * Remove OUR control flow from the transcript before the real request.
 *
 * Returns the SAME array reference when nothing matched — callers compare by
 * identity to decide whether the payload has to be rebuilt. A message left
 * with no parts is dropped entirely (an empty assistant turn is worse than no
 * turn at all).
 */
export function filterPreflightControlFlow(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): readonly vscode.LanguageModelChatRequestMessage[] {
  let changed = false;
  const filtered: vscode.LanguageModelChatRequestMessage[] = [];

  for (const message of messages) {
    const hasPreflightPart = message.content.some(isPreflightPart);
    const content = message.content.filter(
      (part) => !isPreflightPart(part) && !(hasPreflightPart && isEmptyTextPart(part))
    );
    if (content.length === message.content.length) {
      filtered.push(message);
      continue;
    }
    changed = true;
    if (content.length > 0) {
      filtered.push({ ...message, content });
    }
  }

  return changed ? filtered : messages;
}

/**
 * Id for a synthetic activation call: short, `[\w]`-only, and round-tagged so
 * `inspectActivatePreflight` can count rounds straight off the transcript.
 */
export function createPreflightToolCallId(round: number, toolName: string): string {
  const hash = createHash('sha256').update(toolName).digest('hex').slice(0, TOOL_NAME_HASH_LENGTH);
  return `${PREFLIGHT_CALL_ID_PREFIX}${round}${CALL_ID_SEPARATOR}${hash}`;
}

function collectActivateToolNames(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    if (!tool.name.startsWith(ACTIVATE_TOOL_PREFIX) || seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    names.push(tool.name);
  }
  return names;
}

/**
 * The last user message the HUMAN wrote. Preceding turns carry tool results
 * masquerading as user messages, and an activation round only ever follows the
 * real prompt — so counting rounds before that index would over-count.
 */
function findLatestHumanUserMessageIndex(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }
    if (message.content.some(isHumanUserMessagePart)) {
      return index;
    }
  }
  return -1;
}

function isHumanUserMessagePart(part: unknown): boolean {
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return false;
  }
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value.length > 0;
  }
  return true;
}

function parsePreflightPart(part: unknown): { round: number; toolName?: string } | undefined {
  if (part instanceof vscode.LanguageModelToolCallPart) {
    const round = parsePreflightToolCallId(part.callId);
    return round === undefined ? undefined : { round, toolName: part.name };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    const round = parsePreflightToolCallId(part.callId);
    return round === undefined ? undefined : { round };
  }
  return undefined;
}

function isPreflightPart(part: unknown): boolean {
  return (
    (part instanceof vscode.LanguageModelToolCallPart ||
      part instanceof vscode.LanguageModelToolResultPart) &&
    part.callId.startsWith(PREFLIGHT_CALL_ID_PREFIX)
  );
}

function isEmptyTextPart(part: unknown): boolean {
  return part instanceof vscode.LanguageModelTextPart && part.value.length === 0;
}

function parsePreflightToolCallId(callId: string): number | undefined {
  if (!callId.startsWith(PREFLIGHT_CALL_ID_PREFIX)) {
    return undefined;
  }
  const value = callId.slice(PREFLIGHT_CALL_ID_PREFIX.length);
  const separator = value.indexOf(CALL_ID_SEPARATOR);
  if (separator < 0) {
    return undefined;
  }
  const round = Number.parseInt(value.slice(0, separator), 10);
  return Number.isSafeInteger(round) && round >= 1 ? round : undefined;
}
