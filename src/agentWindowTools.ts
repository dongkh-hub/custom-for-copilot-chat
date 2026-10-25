/**
 * Agents-window tool visibility.
 *
 * The Agents window runs the Copilot SDK runtime, which by default defers MCP
 * and non-core VS Code tools behind a tool-search tool
 * (`chat.agentHost.copilot.toolSearch.enabled`, defer threshold 1): the model
 * is expected to discover them on demand instead of receiving every definition
 * up front. A BYOK model that never issues that search call therefore sees
 * almost none of the host's tools — the window looks broken even though every
 * tool is registered.
 *
 * This command writes the opposite pair, and can undo it again:
 *
 *   `chat.agentHost.copilot.toolSearch.enabled`        = false
 *   `chat.agentHost.copilot.modelCapabilityOverrides` += { "*": { availableTools: ["*"] } }
 *
 * Both keys belong to VS Code, so the writes stay conservative:
 *   - nothing is written unless the running build registers both keys;
 *   - the override map is merged ONE entry at a time, so per-model overrides
 *     belonging to the user or to another extension survive;
 *   - `*` is the SDK's own wildcard: it matches every model, and inside
 *     `availableTools` it expands to all tool sources.
 *
 * Both settings are applied when a session launches, so a change only reaches
 * an already-open Agents window after a restart.
 */
import * as vscode from 'vscode';

/** Section owning both keys. */
const SECTION = 'chat.agentHost.copilot';

/** Defers tools behind tool search when true. */
const TOOL_SEARCH_KEY = 'toolSearch.enabled';

/** Object map of `modelId` → capability override. */
const OVERRIDES_KEY = 'modelCapabilityOverrides';

/** The SDK's wildcard: every model / every tool source. */
const WILDCARD = '*';

/** Result of a write attempt. */
export type AgentWindowToolOutcome = 'applied' | 'unsupported';

/** What the running build exposes and which way it is currently set. */
export interface AgentWindowToolState {
  /** Both keys are registered by this build. */
  registered: boolean;
  /** Tool search off AND the wildcard override present. */
  fullVisibility: boolean;
}

/** Shape of `WorkspaceConfiguration.inspect()` this module reads. */
interface InspectShape<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

function globalMap(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Key of the wildcard entry as it is currently spelled, if present. */
function wildcardKey(map: Record<string, unknown>): string | undefined {
  return Object.keys(map).find((key) => key.toLowerCase() === WILDCARD);
}

/**
 * Whether `map` carries a wildcard entry whose `availableTools` includes the
 * wildcard — i.e. the override that actually opens all tool sources.
 */
function opensAllSources(map: Record<string, unknown>): boolean {
  const key = wildcardKey(map);
  if (!key) {
    return false;
  }
  const entry = map[key];
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const tools = (entry as { availableTools?: unknown }).availableTools;
  return Array.isArray(tools) && tools.includes(WILDCARD);
}

function readState(): {
  config: vscode.WorkspaceConfiguration;
  search: InspectShape<boolean> | undefined;
  overrides: InspectShape<Record<string, unknown>> | undefined;
} {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    config,
    search: config.inspect<boolean>(TOOL_SEARCH_KEY),
    overrides: config.inspect<Record<string, unknown>>(OVERRIDES_KEY),
  };
}

/** A registered boolean carries a boolean default; the override map carries `{}`. */
function registered(
  search: InspectShape<boolean> | undefined,
  overrides: InspectShape<Record<string, unknown>> | undefined
): boolean {
  return (
    typeof search?.defaultValue === 'boolean' &&
    typeof overrides?.defaultValue === 'object' &&
    overrides.defaultValue !== null
  );
}

/** Current state, for the menu's radio marks. */
export function readAgentWindowToolState(): AgentWindowToolState {
  const { search, overrides } = readState();
  if (!registered(search, overrides)) {
    return { registered: false, fullVisibility: false };
  }
  const map = globalMap(overrides?.globalValue);
  return {
    registered: true,
    fullVisibility: search?.globalValue === false && opensAllSources(map),
  };
}

/**
 * Send every tool definition up front: tool search off, plus the wildcard
 * capability override. Idempotent — a key already at its target value is left
 * alone, so re-running the command never churns the user's settings file.
 */
export async function applyFullToolVisibility(): Promise<AgentWindowToolOutcome> {
  const { config, search, overrides } = readState();
  if (!registered(search, overrides)) {
    return 'unsupported';
  }
  if (search?.globalValue !== false) {
    await config.update(TOOL_SEARCH_KEY, false, vscode.ConfigurationTarget.Global);
  }
  const map = globalMap(overrides?.globalValue);
  if (!opensAllSources(map)) {
    const key = wildcardKey(map) ?? WILDCARD;
    const entry = globalMap(map[key]);
    await config.update(
      OVERRIDES_KEY,
      { ...map, [key]: { ...entry, availableTools: [WILDCARD] } },
      vscode.ConfigurationTarget.Global
    );
  }
  return 'applied';
}

/**
 * Undo {@link applyFullToolVisibility}: drop both keys back to "unset".
 * Only the wildcard entry is removed from the override map — everything the
 * user configured for a specific model stays.
 */
export async function restoreAgentWindowToolDefaults(): Promise<AgentWindowToolOutcome> {
  const { config, search, overrides } = readState();
  if (!registered(search, overrides)) {
    return 'unsupported';
  }
  if (search?.globalValue !== undefined) {
    await config.update(TOOL_SEARCH_KEY, undefined, vscode.ConfigurationTarget.Global);
  }
  const map = globalMap(overrides?.globalValue);
  const key = wildcardKey(map);
  if (key) {
    const next = { ...map };
    delete next[key];
    await config.update(
      OVERRIDES_KEY,
      Object.keys(next).length > 0 ? next : undefined,
      vscode.ConfigurationTarget.Global
    );
  }
  return 'applied';
}

/** One menu row. */
interface ToolVisibilityRow extends vscode.QuickPickItem {
  mode: 'full' | 'restore';
}

/** The picker: two rows with radio marks, the filled one being the live state. */
export async function showAgentWindowToolsMenu(): Promise<void> {
  const state = readAgentWindowToolState();
  if (!state.registered) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'This VS Code build does not register the Agents-window tool settings — nothing to configure.'
      )
    );
    return;
  }
  const mark = (on: boolean): string => (on ? '$(circle-filled)' : '$(circle-outline)');
  const rows: ToolVisibilityRow[] = [
    { label: `${mark(state.fullVisibility)} ${vscode.l10n.t('Send all tools up front')}`, mode: 'full' },
    { label: `${mark(!state.fullVisibility)} ${vscode.l10n.t('Restore defaults (tool search on)')}`, mode: 'restore' },
  ];
  const picked = await vscode.window.showQuickPick(rows, {
    title: vscode.l10n.t('Agents window tool visibility'),
    matchOnDescription: false,
    matchOnDetail: false,
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  if (picked.mode === 'full') {
    if (state.fullVisibility) {
      return;
    }
    await applyFullToolVisibility();
    // The setting is read when a window starts, so this one cannot pick it up.
    // The button is offered rather than pressed for the user: reloading an
    // Agents window drops the conversation running in it, which has to stay
    // their call.
    const reload = vscode.l10n.t('Reload window');
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t('Applied — restart the Agents window to take effect.'),
        reload
      )
      .then((action) => {
        if (action === reload) {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
    return;
  }
  if (!state.fullVisibility) {
    return;
  }
  await restoreAgentWindowToolDefaults();
  void vscode.window.showInformationMessage(vscode.l10n.t('Restored defaults.'));
}
