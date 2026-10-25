/**
 * The setup wizard: add ONE model profile, then hand the keyboard to Copilot
 * Chat. Also the one-time activation hint that leads a fresh install into the
 * wizard.
 *
 * A profile = endpoint + display alias + REAL model id + API key. Several
 * profiles coexist, each showing up in the picker under its own alias — that
 * is what makes "two gateways" or "same gateway, two keys" usable.
 *
 * The ONE model-management entry point is the `customModel.manageModels`
 * command — the `customModel.modelList` setting's description link and the
 * command palette both land there. Empty list → straight into the add wizard.
 * Otherwise it opens a read-only inventory of every group (the settings
 * mirror's rows), where picking a group offers update model ID / copy model
 * ID / remove, and the LAST row is always "add", so new groups are appended,
 * never spliced in. Host defaults written at the end are fill-only, so a save
 * never disturbs a slot the user chose themselves.
 */
import * as vscode from 'vscode';
import {
  STATE_KEYS,
  newProfileKey,
  normalizeBaseURL,
  profileHasCredentials,
  readProfileApiKey,
  resolveProfileEntry,
  summaryInputTokens,
  summaryWindowLabel,
  tokenWindowLabel,
  writeProfileApiKey,
  type Profile,
} from './config';
import { readProfiles, removeProfile, upsertProfile } from './profileStore';
import {
  isCopilotChatAvailable,
  openCopilotChatExtension,
  waitUntilCopilotChatAvailable,
} from './copilotChat';
import { notifyProviderChanged } from './provider';
import { defaultChatUtilitySettingsToOwnModel } from './hostDefaults';

/**
 * Reveal the Copilot Chat view and put keyboard focus into its input box, so
 * the user can start typing right after the setup wizard finishes.
 *
 * Two commands on purpose: `chat.open` reveals the view, and only
 * `chat.focusInput` puts the caret in its input box (opening the view can
 * leave focus on the view container or on the last focused editor).
 *
 * If either command is unavailable in a future/older build this fails
 * silently; setup itself has already succeeded.
 */
async function focusChatInput(): Promise<void> {
  for (const command of ['workbench.action.chat.open', 'workbench.action.chat.focusInput']) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      // Non-fatal: the chat view may be unavailable (e.g. chat setup hidden).
    }
  }
}

/** `host` of an endpoint, or the URL itself when it does not parse. */
function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}

/**
 * A base URL this provider can actually POST to: an http(s) scheme and a
 * host. Catching it here is the only place a typo can still be corrected —
 * once stored, a scheme-less URL fails inside `fetch` with an opaque error on
 * every message.
 */
function isUsableBaseURL(baseURL: string): boolean {
  try {
    const parsed = new URL(baseURL);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Limits half of a summary: `Beta V4 (1M/128K)` for a known preset, otherwise
 * `default 1M/128K`.
 */
function entryLimitsLabel(profile: Profile): string {
  const entry = resolveProfileEntry(profile);
  // The real ceiling, not the starting rung — a preset label like
  // "Beta V4 (1M/128K)" describes what the model can do.
  const limits = `${summaryWindowLabel(summaryInputTokens(profile))}/${tokenWindowLabel(entry.maxOutputTokens)}`;
  return entry.presetLabel ?? vscode.l10n.t('default {0}', limits);
}

/**
 * One line of the post-save summary, e.g.
 * `my-gateway → Beta V4 (1M/128K)` or `my-model → default 1M/128K`.
 */
function entrySummaryLine(profile: Profile): string {
  return `${profile.name || profile.model} → ${entryLimitsLabel(profile)}`;
}

/**
 * Remove ONE profile (its SecretStorage key included). Two taps: the manager's
 * remove action, then a modal confirmation — deleting a credential by accident
 * is not recoverable.
 */
async function confirmAndRemoveProfile(
  context: vscode.ExtensionContext,
  profile: Profile
): Promise<void> {
  const label = profile.name || profile.model;
  const remove = vscode.l10n.t('Remove');
  const confirmed = await vscode.window.showWarningMessage(
    vscode.l10n.t('Remove "{0}"? Its API key is deleted too.', label),
    { modal: true },
    remove
  );
  if (confirmed !== remove) {
    return;
  }
  await removeProfile(profile.key);
  await writeProfileApiKey(context, profile.key, '');
  notifyProviderChanged();
  // Host slots naming the removed profile are stale now; point them at the
  // first remaining one (fill-only otherwise).
  await defaultChatUtilitySettingsToOwnModel();
  void vscode.window.showInformationMessage(vscode.l10n.t('Removed {0}.', label));
}

/**
 * Every list-editing flow needs Copilot Chat: the provider itself does not,
 * but the model picker that surfaces the groups lives there.
 */
async function ensureCopilotChat(): Promise<boolean> {
  if (isCopilotChatAvailable()) {
    return true;
  }
  const action = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'GitHub Copilot Chat is not enabled — the custom model picker lives there. Enable it first.'
    ),
    vscode.l10n.t('Open Extensions')
  );
  if (action) {
    await openCopilotChatExtension();
  }
  return false;
}

/**
 * Straight into the wizard for a NEW group — the manager's empty-list entry,
 * its trailing "add" row and the one-time setup hint's button all land here
 * (there is nothing to pick when the intent is to add).
 *
 * Returns whether a group was actually SAVED, so the manager can tell a
 * finished add (leave — the user is done managing) from a declined one
 * (return to the list).
 */
export async function addModelProfile(context: vscode.ExtensionContext): Promise<boolean> {
  if (!(await ensureCopilotChat())) {
    return false;
  }
  return modelWizard(context);
}

/** What picking a group in the manager offers. */
type ManageAction = 'update' | 'duplicate' | 'remove';

/** One row of the manager list: a configured group, or the trailing "add". */
type ManageItem = vscode.QuickPickItem & { profile?: Profile; add?: boolean };

/**
 * `customModel.manageModels` — the ONE management surface (settings link +
 * command palette).
 *
 * Empty list → the add wizard directly: an empty picker has nothing to pick.
 * Otherwise the picker is a READ-ONLY inventory of every group — the same
 * facts the settings mirror shows (alias, model id, limits, ⚠ key state) —
 * and the affordances live one level down: picking a group opens the action
 * menu (update model ID / duplicate / remove), Esc there falls back to the
 * list, and those actions re-open it so several groups can be tended in one
 * visit. The LAST row is always "add", pinned with `alwaysShow`, so the list
 * only ever grows by appending.
 *
 * ADDING is the one action that ENDS the visit: the wizard hands focus to
 * Copilot Chat, and re-opening the list afterwards would put the picker back
 * in front of the input the user is about to type in. A declined add (Esc
 * anywhere in the wizard) comes back here — the user never left.
 */
export async function manageModels(context: vscode.ExtensionContext): Promise<void> {
  if (readProfiles().length === 0) {
    // Nothing to inventory: the wizard IS the manager here, and a saved
    // group ends the visit. A declined one falls through to the loop, which
    // exits on the still-empty list.
    if (await addModelProfile(context)) {
      return;
    }
  }
  for (;;) {
    const profiles = readProfiles();
    if (profiles.length === 0) {
      // The wizard was declined (first entry), or the last group was just
      // removed. Re-triggering the wizard here would loop on a declined
      // intent, and an empty manager has nothing to offer.
      return;
    }
    const present = new Set<string>();
    for (const profile of profiles) {
      // Same fact the settings mirror shows: a keyless endpoint is
      // configured, not "missing a key", and gets no ⚠.
      if (profileHasCredentials(profile, await readProfileApiKey(context, profile))) {
        present.add(profile.key);
      }
    }
    const items: ManageItem[] = profiles.map((profile) => {
      const entry = resolveProfileEntry(profile);
      // Same figure the settings mirror shows (the real ceiling).
      const limits = `${summaryWindowLabel(summaryInputTokens(profile))}/${tokenWindowLabel(entry.maxOutputTokens)}`;
      return {
        label: profile.name || profile.model,
        description: `${profile.model} · ${limits}`,
        detail:
          hostOf(profile.baseURL) +
          (present.has(profile.key) ? '' : ` · ⚠ ${vscode.l10n.t('no API key')}`),
        profile,
      };
    });
    items.push({ label: vscode.l10n.t('$(add) Add model…'), alwaysShow: true, add: true });
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Manage models'),
      placeHolder: vscode.l10n.t('Pick a group to manage, or add a new one'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) {
      return;
    }
    if (picked.add || !picked.profile) {
      if (picked.add) {
        // A SAVED group ends the visit: the wizard already handed focus to
        // Copilot Chat, and re-opening the list would only put the picker
        // back in front of the input the user is about to type in. A
        // DECLINED add (Esc anywhere in the wizard) returns to the list —
        // the user never left, so there is nothing to conclude.
        if (await addModelProfile(context)) {
          return;
        }
      }
      continue;
    }
    const action = await pickManageAction(picked.profile);
    if (!action) {
      continue; // Esc at the action menu → back to the list
    }
    if (action === 'update') {
      await updateModelIdFlow(picked.profile);
    } else if (action === 'duplicate') {
      await duplicateModelFlow(context, picked.profile);
    } else {
      await confirmAndRemoveProfile(context, picked.profile);
    }
  }
}

/**
 * The manager's second screen: what to do with the picked group. Esc returns
 * `undefined` and the caller re-opens the list.
 */
async function pickManageAction(profile: Profile): Promise<ManageAction | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: vscode.l10n.t('$(edit) Update model ID…'),
        description: vscode.l10n.t('The endpoint, alias and API key are kept.'),
        value: 'update' as const,
      },
      {
        label: vscode.l10n.t('$(copy) Duplicate model…'),
        description: vscode.l10n.t(
          'The base URL and API key are copied; the alias and model ID are new.'
        ),
        value: 'duplicate' as const,
      },
      {
        label: vscode.l10n.t('$(trash) Remove model…'),
        description: vscode.l10n.t('Its API key is deleted too.'),
        value: 'remove' as const,
      },
    ],
    {
      title: profile.name || profile.model,
      placeHolder: vscode.l10n.t('Pick an action'),
    }
  );
  return picked?.value;
}

/**
 * Duplicate ONE group onto a fresh row: the base URL and the API key are
 * copied, the alias and the model ID are asked for. The case is the provider
 * whose single endpoint serves several models — cloning the group beats
 * re-running the wizard (re-pasting the same URL and key) for each model the
 * user wants in the picker, and a keyless source stays keyless (`noAuth`
 * rides along; the secret, when there is one, is copied to the NEW profile
 * key, so the two groups' keys live and die independently). The alias is
 * prefilled with the source's; the model ID starts EMPTY, because a carbon
 * copy of both would render two indistinguishable rows. The new row lands at
 * the END of the list, like every add. Explicit limits ride along, for the
 * same reason they survive an ID update: they are the user's explicit choice.
 */
async function duplicateModelFlow(
  context: vscode.ExtensionContext,
  profile: Profile
): Promise<void> {
  const alias = await vscode.window.showInputBox({
    title: vscode.l10n.t('Display alias — shown in the model picker'),
    value: profile.name,
    placeHolder: vscode.l10n.t('e.g. My gateway · My model'),
    ignoreFocusOut: true,
    prompt: vscode.l10n.t(
      'Leave empty to show the model id. The alias never goes into the request.'
    ),
  });
  if (alias === undefined) {
    return;
  }
  const entered = await vscode.window.showInputBox({
    title: vscode.l10n.t('API model ID'),
    value: '',
    placeHolder: profile.model,
    ignoreFocusOut: true,
    prompt: `${vscode.l10n.t(
      'Sent as the `model` parameter in the request body; token limits are detected from the id.'
    )} ${vscode.l10n.t('The base URL and API key are copied from "{0}".', profile.name || profile.model)}`,
  });
  if (entered === undefined) {
    return;
  }
  const model = entered.trim();
  if (model.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('A model ID is required.'));
    return;
  }
  try {
    const key = newProfileKey();
    const clone: Profile = {
      key,
      name: alias.trim(),
      baseURL: profile.baseURL,
      model,
      ...(profile.noAuth ? { noAuth: true } : {}),
      maxInputTokens: profile.maxInputTokens,
      maxOutputTokens: profile.maxOutputTokens,
    };
    const apiKey = await readProfileApiKey(context, profile);
    if (apiKey) {
      await writeProfileApiKey(context, key, apiKey);
    }
    await upsertProfile(clone);
    notifyProviderChanged();
    // Fill-only: slots the user pointed elsewhere are never touched; an
    // appended row never invalidates an existing one.
    await defaultChatUtilitySettingsToOwnModel();
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Duplicated model group: {0}', entrySummaryLine(clone))
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Duplicating the model failed: {0}', message)
    );
  }
}

/**
 * Change ONE group's model ID in place, leaving endpoint, alias, API key and
 * explicit limits exactly as they are.
 *
 * The use case is the provider whose URL and key are stable while the served
 * model id moves (a dated snapshot like `…-1017`, a family bump): re-running
 * the wizard would re-paste the same endpoint and key just to change one
 * string, and remove-and-readd would burn the stored key. The input is
 * PREFILLED with the current id, so a version bump is an edit, not a retyping.
 * Token limits re-detect from the new id unless the group carries explicit
 * ones (a gear choice made for the old model is still the user's explicit
 * choice, and is never silently reset).
 */
async function updateModelIdFlow(profile: Profile): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: vscode.l10n.t('API model ID'),
    value: profile.model,
    ignoreFocusOut: true,
    prompt: `${vscode.l10n.t(
      'Sent as the `model` parameter in the request body; token limits are detected from the id.'
    )} ${vscode.l10n.t('The endpoint, alias and API key are kept.')}`,
  });
  if (entered === undefined) {
    return;
  }
  const model = entered.trim();
  if (model.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('A model ID is required.'));
    return;
  }
  if (model === profile.model) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('"{0}" already uses this model ID — nothing changed.', profile.model)
    );
    return;
  }
  const next: Profile = { ...profile, model };
  try {
    await upsertProfile(next);
    // Make VS Code re-query the provider's model list — the picker id
    // (`<profileKey>::<model>`) changed with the id.
    notifyProviderChanged();
    // Host slots may name the OLD picker id; the repair is stale-only, so a
    // slot the user pointed somewhere else is never touched.
    await defaultChatUtilitySettingsToOwnModel();
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Model updated: {0} → {1} · {2}',
        profile.model,
        model,
        entryLimitsLabel(next)
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Updating the model failed: {0}', message)
    );
  }
}

/**
 * ④ API key — or an explicit "this gateway needs none".
 *
 * Self-hosted gateways are often keyless (a local inference server started
 * without an auth flag). Empty input therefore does NOT abort: it asks
 * whether the endpoint really needs no key, because the alternative readings
 * — "I forgot to paste it" and "the key is empty" — are indistinguishable from
 * the text. Answering "No key" is an explicit, stored decision
 * (`Profile.noAuth`), not an empty secret, so a gateway that DOES need a key
 * still shows its ⚠ and reports a clear error instead of silently sending
 * unauthenticated requests.
 */
async function promptApiKey(): Promise<{ apiKey: string } | undefined> {
  for (;;) {
    const entered = await vscode.window.showInputBox({
      title: vscode.l10n.t('④ API key'),
      password: true,
      ignoreFocusOut: true,
      prompt: vscode.l10n.t(
        'Stored in this machine’s SecretStorage, never in settings. Leave empty if this gateway needs no key.'
      ),
    });
    if (entered === undefined) {
      return undefined;
    }
    if (entered.trim().length > 0) {
      return { apiKey: entered.trim() };
    }
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: vscode.l10n.t('No key — this gateway does not require one'),
          description: vscode.l10n.t(
            'A self-hosted inference server started without an auth flag'
          ),
          value: 'none' as const,
        },
        {
          label: vscode.l10n.t('Enter a key'),
          description: '',
          value: 'retry' as const,
        },
      ],
      {
        title: vscode.l10n.t('This endpoint needs no API key?'),
        placeHolder: vscode.l10n.t('Pick one'),
        ignoreFocusOut: true,
      }
    );
    if (!choice) {
      return undefined;
    }
    if (choice.value === 'none') {
      return { apiKey: '' };
    }
  }
}

/**
 * ① URL ② alias ③ model id ④ API key, then persist — ONE NEW GROUP per run.
 *
 * There is deliberately no "pick an existing group to edit" here: running the
 * wizard always creates a new group; swapping just the model id of an
 * existing one is `updateModelIdFlow`'s job, and anything else still means
 * removing the group and adding it again. The key goes to SecretStorage
 * under the profile key; nothing credential-like is written into settings —
 * the only setting this extension writes is the READ-ONLY model-list mirror
 * (see modelListSetting.ts). `notifyProviderChanged()` makes VS Code re-query
 * the model list — no window reload needed.
 *
 * Returns `true` only when a group was SAVED — `false` for every abandoned
 * step (Esc, an empty required field, a failed write), so the caller can tell
 * "done" from "changed my mind".
 */
async function modelWizard(context: vscode.ExtensionContext): Promise<boolean> {
  const url = await vscode.window.showInputBox({
    title: vscode.l10n.t('① API base URL — OpenAI-compatible'),
    value: '',
    placeHolder: 'https://api.example.com/v1',
    ignoreFocusOut: true,
    prompt: vscode.l10n.t('e.g. https://api.example.com/v1'),
  });
  if (!url || url.trim().length === 0) {
    return false;
  }
  // Accept a pasted ENDPOINT too (`https://x/v1/chat/completions`): the
  // request path appends the suffix itself, so storing it verbatim would
  // double it and answer 404 — which no recovery step retries.
  const baseURL = normalizeBaseURL(url);
  if (!isUsableBaseURL(baseURL)) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('The base URL must start with http:// or https:// and include a host.')
    );
    return false;
  }

  // The ALIAS is display-only. It is what the picker shows; the request body
  // still carries the model id asked for next.
  const alias = await vscode.window.showInputBox({
    title: vscode.l10n.t('② Display alias — shown in the model picker'),
    value: '',
    placeHolder: vscode.l10n.t('e.g. My gateway · My model'),
    ignoreFocusOut: true,
    prompt: vscode.l10n.t(
      'Leave empty to show the model id. The alias never goes into the request.'
    ),
  });
  if (alias === undefined) {
    return false;
  }

  const modelIdRaw = await vscode.window.showInputBox({
    title: vscode.l10n.t('③ API model ID'),
    value: '',
    placeHolder: 'my-model-v1, another-model, chat-model, reasoning-model …',
    ignoreFocusOut: true,
    prompt: vscode.l10n.t(
      'Sent as the `model` parameter in the request body; token limits are detected from the id.'
    ),
  });
  if (modelIdRaw === undefined) {
    return false;
  }
  const model = modelIdRaw.trim();
  if (model.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('A model ID is required.'));
    return false;
  }

  const answer = await promptApiKey();
  if (!answer) {
    return false;
  }
  const apiKey = answer.apiKey;

  try {
    const key = newProfileKey();
    const profile: Profile = {
      key,
      name: alias.trim(),
      baseURL,
      model,
      // Only a keyless endpoint carries the flag; a keyed one must never
      // inherit it, or a later "key removed" would read as "no auth needed".
      ...(apiKey ? {} : { noAuth: true }),
      maxInputTokens: 0,
      maxOutputTokens: 0,
    };
    if (apiKey) {
      await writeProfileApiKey(context, key, apiKey);
    }
    await upsertProfile(profile);
    // Make VS Code re-query the provider's model list.
    notifyProviderChanged();
    // Point VS Code's background utility flows (which otherwise fail or burn
    // Copilot quota under a BYOK main model) at the first profile. User-set
    // values are never overwritten.
    await defaultChatUtilitySettingsToOwnModel();
    // The applied limits (official preset vs default) are the one thing the
    // user cannot see in the chat input they land on — one toast, then focus.
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Model limits applied: {0}', entrySummaryLine(profile))
    );
    await focusChatInput();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Custom for Copilot Chat setup failed: {0}', message)
    );
    return false;
  }
}

/**
 * One-time setup hint shown once Copilot Chat is available.
 *
 * Button semantics:
 *   "Add Model…" / "Skip" — both permanent: the hint never shows again.
 *   Esc / closing the notification sets NOTHING, so it returns on the next
 *   activation — that is the only "remind me later" path.
 */
export async function maybeShowSetupHint(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(STATE_KEYS.SETUP_HINT)) {
    return;
  }
  if (!(await waitUntilCopilotChatAvailable())) {
    return;
  }
  // A profile is stored — nothing to hint about (e.g. after restoring a
  // profile or reinstalling the extension).
  if (readProfiles().length > 0) {
    await context.globalState.update(STATE_KEYS.SETUP_HINT, true);
    return;
  }
  const setUp = vscode.l10n.t('Add Model…');
  const skip = vscode.l10n.t('Skip');
  const action = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Configure the API URL and key to use a custom model in Copilot Chat.'
    ),
    setUp,
    skip
  );
  if (action === setUp) {
    await context.globalState.update(STATE_KEYS.SETUP_HINT, true);
    await addModelProfile(context);
  } else if (action === skip) {
    await context.globalState.update(STATE_KEYS.SETUP_HINT, true);
  }
  // Esc / closed: set NOTHING — the hint shows again next activation.
}
