/**
 * Proposed-API `LanguageModelThinkingPart` helpers.
 *
 * `LanguageModelThinkingPart` is a PROPOSED API and is absent from every
 * stable host in the supported range, so the class is resolved at RUNTIME:
 * absent → thinking deltas are dropped, present → they stream to the chat UI
 * like any other part.
 */
import * as vscode from 'vscode';

/** Constructor shape of the proposed thinking part. */
type ThinkingPartCtor = new (value: string | string[]) => { value: string | string[] };

function thinkingPartClass(): ThinkingPartCtor | undefined {
  const candidate = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
  return typeof candidate === 'function' ? (candidate as ThinkingPartCtor) : undefined;
}

export function isThinkingPart(part: unknown): boolean {
  const ctor = thinkingPartClass();
  return ctor !== undefined && part instanceof ctor;
}

export function thinkingPartText(part: unknown): string {
  const value = (part as { value: string | string[] }).value;
  return Array.isArray(value) ? value.join('') : value;
}

/**
 * Forward a reasoning delta. Returns false when the host has no thinking part
 * (older VS Code) — in that case the text is simply not shown; the request
 * itself is unaffected. Passthrough is always on (fixed behavior).
 */
export function reportThinking(
  text: string,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): boolean {
  const ctor = thinkingPartClass();
  if (!ctor) {
    return false;
  }
  // Not in the stable `LanguageModelResponsePart` union — the cast is the same
  // one the proposed API's own consumers use.
  progress.report(new ctor(text) as unknown as vscode.LanguageModelResponsePart);
  return true;
}
