/**
 * `customModel.modelList` — a READ-ONLY MIRROR of the configured model groups,
 * so the Settings UI can show them at all.
 *
 * WHY THIS SETTING EXISTS. The list lives in the user-level credential store
 * (`profileStore.ts`), which is application-scoped and therefore invisible to
 * every UI surface: Settings renders settings, and a secret is not one. Before
 * this mirror, "which models do I have, and which one lost its key?" had no
 * answer short of running a command. The setting carries no data the extension
 * reads — it is written, never parsed back.
 *
 * WHAT IT CARRIES, AND WHAT IT MUST NEVER CARRY:
 *   alias → real model id · resolved input/output limits · whether the key is
 *   present. Never the endpoint and never the key: keeping both out of
 *   settings.json is the entire reason the list moved to SecretStorage.
 *   `scope: machine` keeps the mirror out of Settings Sync, so this machine's
 *   inventory is not copied to another machine whose keys are absent — every
 *   line there would read "no API key" for a group that simply belongs
 *   somewhere else.
 *
 * WHO WRITES IT. `syncModelListSetting` on every effective-list change — this
 * window's own saves and removals, plus reloads of another window's write —
 * through `profileStore.onProfilesChanged`. A manual edit is therefore not
 * "respected and merged"; it is overwritten the next time anything changes,
 * which is the honest behavior for a display-only mirror (and stated in the
 * setting's description).
 *
 * The write is skipped when the payload is unchanged: this runs on every list
 * change, and a redundant write to settings.json would fire
 * `onDidChangeConfiguration` (→ provider re-query) for nothing.
 *
 * WHY A MULTILINE STRING AND NOT AN ARRAY. VS Code renders an array of strings
 * as an editable item list — a per-row edit pencil, a per-row remove ✕ and an
 * "Add Item" button — i.e. the exact affordances of a setting the user is
 * meant to maintain. A read-only mirror must not offer them: every one of
 * those controls writes a value this extension overwrites on the next change.
 * A single string with `editPresentation: "multilineText"` renders as a plain
 * textarea: the groups are all visible, and there is nothing to click.
 */
import * as vscode from 'vscode';
import {
  modelOutput,
  profileHasCredentials,
  readProfileApiKey,
  resolveProfileEntry,
  summaryInputTokens,
  summaryWindowLabel,
  tokenWindowLabel,
  type Profile,
} from './config';
import { onProfilesChanged, readProfiles } from './profileStore';

/** Section + key of the mirror setting. */
export const MODEL_LIST_SECTION = 'customModel';
export const MODEL_LIST_SETTING_KEY = 'modelList';

/**
 * One line per group: `alias → model id · 1M/128K`, plus `⚠ no API key` when
 * that group has no key stored. Pure — the smoke test pins the shape.
 *
 * Kept as lines (not as one blob) so the rendering and the diffing stay
 * separate concerns; {@link modelListText} joins them for the setting.
 */
export function modelListLines(
  profiles: readonly Profile[],
  keysPresent: ReadonlySet<string> = new Set<string>()
): string[] {
  return profiles.map((profile) => {
    const entry = resolveProfileEntry(profile);
    // The REAL ceiling, not the rung the model starts on: this line is the
    // user's record of what the model can do.
    const limits = `${summaryWindowLabel(summaryInputTokens(profile))}/${tokenWindowLabel(entry.maxOutputTokens)}`;
    const head = profile.name ? `${profile.name} → ${profile.model}` : profile.model;
    const line = `${head} · ${limits}`;
    return keysPresent.has(profile.key) ? line : `${line} · ⚠ ${vscode.l10n.t('no API key')}`;
  });
}

/** The stored value: one line per group, so the textarea reads as a list. */
export function modelListText(
  profiles: readonly Profile[],
  keysPresent: ReadonlySet<string> = new Set<string>()
): string {
  return modelListLines(profiles, keysPresent).join('\n');
}

/**
 * Repaint the mirror from the current list. Fire-and-forget friendly: a
 * refused write is logged, never thrown — the mirror is a convenience, and the
 * list itself is already durable.
 */
export async function syncModelListSetting(context: vscode.ExtensionContext): Promise<void> {
  const profiles = readProfiles();
  const present = new Set<string>();
  for (const profile of profiles) {
    // A keyless endpoint has no secret by design — it is configured, not
    // "missing a key", and the mirror must not show ⚠ for it.
    if (profileHasCredentials(profile, await readProfileApiKey(context, profile))) {
      present.add(profile.key);
    }
  }
  const next = modelListText(profiles, present);
  const config = vscode.workspace.getConfiguration(MODEL_LIST_SECTION);
  let current = '';
  try {
    const raw = config.get<unknown>(MODEL_LIST_SETTING_KEY, '');
    // A non-string (a hand-edited array from an earlier build) never compares
    // equal, so it is repainted instead of being left on screen.
    current = typeof raw === 'string' ? raw : '';
  } catch {
    current = '';
  }
  if (current === next) {
    return;
  }
  try {
    await config.update(
      MODEL_LIST_SETTING_KEY,
      next,
      vscode.ConfigurationTarget.Global
    );
  } catch (err) {
    modelOutput().appendLine(`[modelList] mirror not written — ${String(err)}`);
  }
}

/**
 * Keep the mirror in step for this window: paint once at activation, then on
 * every change to the effective list.
 */
export function registerModelListMirror(context: vscode.ExtensionContext): void {
  void syncModelListSetting(context);
  context.subscriptions.push(
    onProfilesChanged(() => {
      void syncModelListSetting(context);
    })
  );
}
