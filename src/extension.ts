/**
 * Custom for Copilot Chat — main entry point.
 *
 * Registers a first-class `LanguageModelChatProvider` (vendor `custommodel`)
 * backed by any OpenAI-compatible endpoint the user configures (API base URL +
 * API key), plus the Agents-window compatibility defaults.
 *
 * Activation wiring, in order:
 *   0. the profile store — the shared, user-level credential list every other
 *      step reads;
 *   1. the model provider (so silent discovery can enumerate right away);
 *   2. the two always-on surfaces over the list — the settings mirror and the
 *      status-bar count, both one click away from the manager;
 *   3. the Agents-window defaults — written ONCE per install, so the separate
 *      Agents window can open without a GitHub sign-in and loads this
 *      extension (allow-list entry) — see agentWindow.ts;
 *   4. the commands (manage models, Agents-window tool visibility, reset
 *      learned capabilities);
 *   5. the one-time setup hint (only when Copilot Chat is enabled and no key
 *      is stored yet).
 *
 * The list lives in SecretStorage, which is shared by every VS Code profile on
 * this machine, so a change made in one window reaches the others through
 * `secrets.onDidChange` (see the listener below) — no reload anywhere.
 */
import * as vscode from 'vscode';
import { registerModelProvider, notifyProviderChanged } from './provider';
import { applyAgentWindowDefaultsOnce } from './agentWindow';
import { defaultChatUtilitySettingsToOwnModel } from './hostDefaults';
import { showAgentWindowToolsMenu } from './agentWindowTools';
import {
  manageModels,
  maybeShowSetupHint,
} from './setup';
import {
  isCopilotChatAvailable,
  waitUntilCopilotChatAvailable,
} from './copilotChat';
import { STATE_KEYS } from './config';
import {
  PROFILES_SECRET_KEY,
  initProfileStore,
  reloadProfiles,
} from './profileStore';
import { registerModelListMirror } from './modelListSetting';
import { registerModelStatusBar } from './statusBar';
import { clearCapabilities, initCapabilityStore, rememberedCount } from './modelCapability';

const LOG_TAG = '[custom-for-copilot-chat]';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log(`${LOG_TAG} activating (host ${vscode.version})`);

  // The model list lives in the USER-LEVEL credential store (see
  // profileStore.ts), so this must complete before anything reads a profile.
  await initProfileStore(context);

  // What individual gateways have TAUGHT this extension about their accepted
  // `reasoning_effort` values (see modelCapability.ts). Read before the
  // provider registers, so the first discovery can already annotate a
  // position an earlier session had refused.
  await initCapabilityStore(context);

  // The settings MIRROR (`customModel.modelList`): the only place outside a
  // command where the configured groups are visible. Written, never read back
  // — see modelListSetting.ts.
  registerModelListMirror(context);

  // Status-bar entry: the group count on the bar, the manager one click away
  // — see statusBar.ts.
  registerModelStatusBar(context);

  // Fill empty host chat slots and repair slots still naming a profile/model
  // that no longer exists (an upgrade leaves `custommodel/eepseek/...`
  // behind). Fill-only otherwise: a value the user chose is never overwritten.
  void defaultChatUtilitySettingsToOwnModel();

  // Native LanguageModelChatProvider (vendor `custommodel`): one entry PER
  // GROUP (shared credential store), each with its own endpoint, alias,
  // model id and SecretStorage key. Registered unconditionally at activation;
  // an unconfigured profile is listed with a warning icon (silent discovery
  // must never prompt).
  context.subscriptions.push(registerModelProvider(context));

  // Another window — typically another VS Code PROFILE — added, edited or
  // removed a group: the shared credential store moved underneath this
  // window. Re-read it, re-query the model list, and repair host slots that
  // may now name a group which no longer exists. Our own writes land here too;
  // `reloadProfiles` compares payloads and answers `false` for them.
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (event.key !== PROFILES_SECRET_KEY) {
        return;
      }
      void (async () => {
        if (!(await reloadProfiles())) {
          return;
        }
        notifyProviderChanged();
        await defaultChatUtilitySettingsToOwnModel();
      })();
    })
  );

  // Agents-window compatibility: the separate Agents window runs its own
  // extension host that only admits a subset of extensions, refuses to start
  // without a GitHub sign-in, and offers no BYOK providers — none of which
  // fits a BYOK-only install. Filled once per install and only into slots the
  // user has not set (agentWindow.ts); a user's own value always wins. The
  // allow-list entry (`extensions.supportAgentsWindow`) is what lets this
  // extension load there at all.
  void applyAgentWindowDefaultsOnce(context);

  // Model management: ONE command (settings link + palette). Empty list →
  // straight into the add wizard; otherwise a read-only inventory of every
  // group where each pick offers update-model-ID / copy-ID / remove, with
  // "add" pinned as the last row so new groups are appended.
  context.subscriptions.push(
    vscode.commands.registerCommand('customModel.manageModels', () => manageModels(context))
  );

  // Tool visibility inside the Agents window. That window's agent is the
  // Copilot SDK runtime, which defers non-core tools behind a tool-search
  // tool by default — a BYOK model that never issues the search call sees
  // almost none of the host's tools. This command is the explicit switch (and
  // its undo); it is never applied automatically, because it trades prompt
  // tokens for tool coverage.
  context.subscriptions.push(
    vscode.commands.registerCommand('customModel.configureAgentWindowTools', () =>
      showAgentWindowToolsMenu()
    )
  );

  // The learned-capability cache has NO expiry: it is what a gateway answered
  // last time, and a gateway upgrade can widen the accepted set (or narrow it).
  // Without an explicit undo, one refusal would downgrade that position
  // forever.
  context.subscriptions.push(
    vscode.commands.registerCommand('customModel.resetCapabilities', async () => {
      const count = rememberedCount();
      if (count === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Nothing learned yet — no endpoint has refused a thinking-effort value.')
        );
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Forget what {0} endpoint/model pair(s) taught this extension? Every thinking-effort position will be sent as chosen again.',
          String(count)
        ),
        { modal: true },
        vscode.l10n.t('Forget')
      );
      if (!confirmed) {
        return;
      }
      await clearCapabilities();
      notifyProviderChanged();
      void vscode.window.showInformationMessage(vscode.l10n.t('Learned capabilities cleared.'));
    })
  );

  // One-time setup hint. Chat disabled (sign-in not yet complete)? Warn about
  // that first, then chain the hint to the enablement flip — including the
  // much-later case via a one-shot listener.
  void runSetupHint(context);

  console.log(`${LOG_TAG} activated.`);
}

/**
 * The activation hint chain, in priority order (see setup.ts).
 *
 * The chat-missing warning is one-time (flag written BEFORE the warning):
 * Esc on the model-setup hint below is the only "remind me later" path.
 */
async function runSetupHint(context: vscode.ExtensionContext): Promise<void> {
  if (isCopilotChatAvailable()) {
    await maybeShowSetupHint(context);
    return;
  }
  if (!context.globalState.get<boolean>(STATE_KEYS.CHAT_HINT)) {
    await context.globalState.update(STATE_KEYS.CHAT_HINT, true);
    const action = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'GitHub Copilot Chat is not enabled — the custom model picker lives there.'
      ),
      vscode.l10n.t('Open Extensions')
    );
    if (action) {
      await vscode.commands.executeCommand('workbench.extensions.search', 'github.copilot-chat');
    }
  }
  if (await waitUntilCopilotChatAvailable()) {
    await maybeShowSetupHint(context);
    return;
  }
  const subscription = vscode.extensions.onDidChange(() => {
    if (!isCopilotChatAvailable()) {
      return;
    }
    subscription.dispose();
    void maybeShowSetupHint(context);
  });
  context.subscriptions.push(subscription);
}

export function deactivate(): void {
  // Everything registered here is disposed via context.subscriptions; no
  // timers or file handles are owned outside of it.
}
