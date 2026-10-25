/**
 * Copilot Chat availability probes — pure `vscode.extensions` / command
 * lookups with no orchestration semantics.
 *
 * This extension's model is consumed by GitHub Copilot Chat. Since VS Code
 * 1.99 Copilot Chat ships as a *built-in* extension, so it can never be "not
 * installed" — it can only be disabled (e.g. VS Code keeps it disabled until
 * GitHub Copilot chat setup / sign-in completes).
 */
import * as vscode from 'vscode';

const COPILOT_CHAT_EXTENSION_ID = 'github.copilot-chat';

/**
 * Check whether GitHub Copilot Chat is enabled.
 *
 * Copilot Chat is a built-in extension on all supported VS Code versions, so
 * "not installed" cannot happen. Moreover the extension host registry only
 * contains *enabled* extensions: `getExtension()` returns `undefined` for a
 * disabled one, so a lookup hit simply means "enabled". No `activate()`
 * probe is needed — its async initialization takes seconds and can reject
 * transiently right after startup or install, which would otherwise be
 * reported as "disabled" by mistake.
 */
export function isCopilotChatAvailable(): boolean {
  return vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID) !== undefined;
}

/**
 * How long a caller waits for chat to become enabled before giving up.
 *
 * Waiting is event-driven (`extensions.onDidChange`), so this is not a poll
 * interval — it bounds how long ONE call stays pending. An unbounded wait
 * holds a promise plus its listener for the rest of the session whenever the
 * user never enables chat; the activation hint path covers that case with a
 * listener of its own, so 30s is enough to absorb the usual sign-in flip.
 */
export const DEFAULT_CHAT_WAIT_MS = 30_000;

/**
 * Wait until GitHub Copilot Chat becomes available, resolving the moment the
 * built-in chat extension flips to enabled (`extensions.onDidChange` fires
 * both when chat setup / sign-in completes and when the user manually
 * enables it).
 *
 * Resolves `false` once `timeoutMs` elapses — a caller that must react to a
 * much later flip should subscribe to `extensions.onDidChange` instead of
 * awaiting a promise that would otherwise never settle.
 */
export function waitUntilCopilotChatAvailable(
  timeoutMs: number = DEFAULT_CHAT_WAIT_MS
): Promise<boolean> {
  if (isCopilotChatAvailable()) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve(result);
    };
    const subscription = vscode.extensions.onDidChange(() => {
      if (isCopilotChatAvailable()) {
        finish(true);
      }
    });
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => finish(false), timeoutMs);
  });
}

/** Open the Extensions view filtered to GitHub Copilot Chat. */
export async function openCopilotChatExtension(): Promise<void> {
  await vscode.commands.executeCommand('workbench.extensions.search', COPILOT_CHAT_EXTENSION_ID);
}
