/**
 * Agents-window (agent host) compatibility settings — written ONCE on first
 * activation, so the separate Agents window can open and actually use the
 * custom model without a GitHub sign-in.
 *
 * VS Code's separate Agents window runs its own extension host and admits only
 * a subset of extensions into it; out of the box it also refuses to start
 * without a GitHub sign-in and offers no BYOK providers. A machine that uses
 * this extension is BYOK-only by design — the model comes from our own
 * `LanguageModelChatProvider`, chat needs no GitHub account — so without all
 * three switches the window either cannot open, opens without our model, or
 * never loads this extension and therefore never registers the provider:
 *
 *   `chat.agentHost.allowSignedOutWhenUsable` = true
 *   `chat.agentHost.byokModels.enabled`       = true
 *   `extensions.supportAgentsWindow`          = { "CustomforCopilotChat.custom-for-copilot-chat": true }
 *
 * The third one is the load gate: a manifest that ships `main`/`browser` runs
 * in that window only when the user's allow-list names the extension, and a
 * disabled extension never runs `provideLanguageModelChatInformation` — the
 * model picker in that window is then empty no matter what the model's own
 * `capabilities` say.
 *
 * All three keys belong to VS Code, not to this extension, so they are filled
 * in conservatively: ONCE per install, at Global scope, and only into slots
 * the user has not filled — an explicit value, either way, always wins and is
 * never rewritten. The allow-list is an object map shared with every other
 * extension, so that write merges a single entry instead of replacing the
 * object.
 */
import * as vscode from 'vscode';
import { STATE_KEYS } from './config';

/** Section that owns the two boolean switches below. */
const AGENT_HOST_SECTION = 'chat.agentHost';

/**
 * Section-relative keys, in write order. Passing the qualified
 * `chat.agentHost.…` name to `getConfiguration(AGENT_HOST_SECTION)` would
 * address `chat.agentHost.chat.agentHost.…`, which is not a registered
 * setting.
 */
const AGENT_HOST_KEYS = ['allowSignedOutWhenUsable', 'byokModels.enabled'] as const;

/** Section that owns the Agents-window allow-list. */
const EXTENSIONS_SECTION = 'extensions';

/** Allow-list key: an object map of `publisher.name` → boolean. */
const AGENTS_WINDOW_SUPPORT_KEY = 'supportAgentsWindow';

const LOG_TAG = '[custom-for-copilot-chat]';

/**
 * Fill the switches when the running build registers them and the user has no
 * value of their own.
 *
 * `extensionId` is this extension's `publisher.name` (the running
 * `ExtensionContext.extension.id`), used as the allow-list key.
 *
 * Returns whether this install can be marked as handled — every key exists in
 * this build and no write failed. `false` means an older VS Code that does not
 * register the keys yet (they ship with the Agents window) or a rejected
 * write; the caller then retries on a later activation instead of burning the
 * one-shot flag. Never throws: a compatibility default is not worth failing
 * activation over.
 */
export async function applyAgentWindowDefaults(extensionId: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration(AGENT_HOST_SECTION);
  let handled = true;
  for (const key of AGENT_HOST_KEYS) {
    const current = config.inspect<boolean>(key);
    // A registered boolean always carries its manifest default; an unknown key
    // inspects without one. Writing it anyway would reject or leave an orphan
    // entry that VS Code flags as an unknown setting.
    if (typeof current?.defaultValue !== 'boolean') {
      handled = false;
      continue;
    }
    // Any scope counts as an explicit user choice — including `false`.
    if (
      current.globalValue !== undefined ||
      current.workspaceValue !== undefined ||
      current.workspaceFolderValue !== undefined
    ) {
      continue;
    }
    try {
      await config.update(key, true, vscode.ConfigurationTarget.Global);
      // Logged because this rewrites the user's own settings with no visible
      // UI: without it there is no way to tell the extension was the author.
      console.log(`${LOG_TAG} agents-window default written: ${AGENT_HOST_SECTION}.${key}`);
    } catch {
      handled = false;
    }
  }
  // Runs regardless of the loop's outcome: one rejected write must not cost the
  // remaining entries, and every step is idempotent on a retry.
  if (!(await allowInAgentsWindow(extensionId))) {
    handled = false;
  }
  return handled;
}

/**
 * Add this extension to the Agents-window allow-list.
 *
 * Returns whether the entry is in place. `true` also covers "the user already
 * listed it" — either value, and in any letter case: the host lowercases the
 * whole `publisher.name` string before lookup, so a second entry differing
 * only in case would be dead weight in the user's settings file. `false` means
 * the running build does not register the setting (nothing to write into) or
 * the write was rejected.
 */
async function allowInAgentsWindow(extensionId: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration(EXTENSIONS_SECTION);
  const current = config.inspect<Record<string, boolean>>(AGENTS_WINDOW_SUPPORT_KEY);
  // A registered object setting carries `{}` as its manifest default; an
  // unknown key inspects without one.
  if (typeof current?.defaultValue !== 'object' || current.defaultValue === null) {
    return false;
  }
  const stored = current.globalValue;
  const entries: Record<string, boolean> =
    typeof stored === 'object' && stored !== null ? { ...stored } : {};
  const wanted = extensionId.toLowerCase();
  if (Object.keys(entries).some((key) => key.toLowerCase() === wanted)) {
    return true;
  }
  entries[wanted] = true;
  try {
    await config.update(AGENTS_WINDOW_SUPPORT_KEY, entries, vscode.ConfigurationTarget.Global);
    console.log(`${LOG_TAG} agents-window allow-list entry written: ${wanted}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install-time wrapper: run the fill once, then remember that this install has
 * been handled. The flag lives in globalState, so a future "reset" flow can
 * clear it and the next activation applies the defaults again — a reset
 * install behaves like a fresh one.
 */
export async function applyAgentWindowDefaultsOnce(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(STATE_KEYS.AGENT_WINDOW_DEFAULTS)) {
    return;
  }
  if (await applyAgentWindowDefaults(context.extension.id)) {
    await context.globalState.update(STATE_KEYS.AGENT_WINDOW_DEFAULTS, true);
  }
}
