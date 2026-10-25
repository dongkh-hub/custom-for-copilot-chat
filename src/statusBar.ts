/**
 * Status-bar entry — the manager one click away.
 *
 * WHY AN ITEM AT ALL. The manager lives behind the command palette and a link
 * deep in the Settings page; a BYOK user who swaps model ids often (the
 * dated-snapshot case) needs it as a first-class surface. The item shows the
 * group COUNT — `✨ 2` — so the bar doubles as a live inventory: adding,
 * duplicating or removing a group repaints it immediately, this window's own
 * writes and other windows' changes alike, through `onProfilesChanged` (the
 * same event the settings mirror rides on; the store is application-scoped,
 * so the count is the same in every window).
 *
 * `0` is shown rather than hidden: on a fresh install the click lands
 * straight in the add wizard (the manager's empty-list path), so the item is
 * also a setup entry point. The whole item is one button — it runs
 * `customModel.manageModels`, the same single entry point the settings link
 * and the palette use; there is no second management surface to keep in
 * step.
 */
import * as vscode from 'vscode';
import { onProfilesChanged, readProfiles } from './profileStore';

/**
 * Create, wire and show the item. `context.subscriptions` owns both the item
 * and the change listener, so the bar never outlives the extension host.
 */
export function registerModelStatusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  // What the status bar's context menu lists under "Custom Mode" — the
  // user-level toggle for hiding this entry.
  item.name = vscode.l10n.t('Custom Mode');
  item.command = 'customModel.manageModels';
  const paint = (): void => {
    const count = readProfiles().length;
    item.text = `$(sparkle) ${count}`;
    item.tooltip = vscode.l10n.t(
      'Custom Mode — {0} model group(s) on this machine. Click to manage.',
      String(count)
    );
  };
  paint();
  item.show();
  context.subscriptions.push(item, onProfilesChanged(paint));
}
