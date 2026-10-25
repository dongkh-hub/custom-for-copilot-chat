/**
 * Host chat/utility settings: point VS Code's BYOK/chat defaults at our own
 * model unless the user has customized them (their explicit choices win).
 *
 * When the main agent model is a BYOK model (our `custommodel` provider), VS
 * Code's built-in background utility flows (session titles, subagents, risk
 * assessment, etc.) would otherwise fail with "No utility model is configured
 * for 'copilot-utility'" — or silently consume the user's Copilot quota when
 * they happen to be signed in. After the model is configured we therefore flip
 * the host defaults so background work also rides the BYOK model:
 *
 *   - `chat.byokUtilityModelDefault` = `mainAgent` (no Copilot sign-in needed)
 *   - `chat.utilityModel`            = `<vendor>/<id>` (explicit main utility slot)
 *   - `chat.utilitySmallModel`       = `<vendor>/<id>` (explicit fast/small slot)
 *   - `chat.defaultModel`            = `<id>` (seed for every NEW chat
 *     conversation in place of Copilot's "Auto"; explicit per-session model
 *     picks are never overridden)
 *
 * Both utility slots point at the SAME model — the first configured entry:
 * helper requests ride the same endpoint as the main agent, and the utility
 * downgrade (requestKind.ts) keeps their cost bounded.
 *
 * Two more host defaults are flipped in the same pass — Copilot Chat's own
 * "agent session" entries (its `chatSessions` contributions). Both are gated
 * on GitHub sign-in, which a BYOK-only machine never has; left enabled they
 * just poll GitHub-backed session lists on every refresh and log warnings for
 * entries that can never work:
 *   - `github.copilot.chat.backgroundAgent.enabled` = `false` (Copilot CLI)
 *   - `github.copilot.chat.cloudAgent.enabled`      = `false` (Cloud Agent)
 *
 * These are SECTION-RELATIVE keys: they are always used together with the
 * configuration section that owns them (`chat.*` via
 * `vscode.workspace.getConfiguration('chat')`, the Copilot gates via
 * `getConfiguration('github.copilot.chat')`). Passing the full `chat.…` name
 * there would resolve to `chat.chat.…`, which is not a registered setting and
 * makes `update()` throw (writing user settings is only allowed for
 * registered keys).
 */
import * as vscode from 'vscode';
import { MODEL_PROVIDER_VENDOR, encodePickerId } from './config';
import { readProfiles } from './profileStore';

const HOST_UTILITY_DEFAULT_SETTING = 'byokUtilityModelDefault';
const HOST_UTILITY_MODEL_SETTING = 'utilityModel';
const HOST_UTILITY_SMALL_MODEL_SETTING = 'utilitySmallModel';
/**
 * Copilot Chat's own section + the two session-type gates auto-disabled with
 * the defaults above (see the doc block above for why). Keys are
 * section-relative here as well.
 */
const GITHUB_COPILOT_CHAT_SECTION = 'github.copilot.chat';
const HOST_BACKGROUND_AGENT_SETTING = 'backgroundAgent.enabled';
const HOST_CLOUD_AGENT_SETTING = 'cloudAgent.enabled';
/**
 * The picker id of the FIRST profile — `<profileKey>::<model>`. Host slots
 * must name the same id VS Code received from `provideLanguageModelChatInformation`,
 * or the lookup finds nothing.
 */
function firstPickerId(): string | undefined {
  const profile = readProfiles()[0];
  return profile ? encodePickerId(profile.key, profile.model) : undefined;
}
/**
 * `<vendor>/<id>` storage format shared by both utility slots. The vendor half
 * MUST be the registered provider vendor, or Copilot Chat resolves nothing
 * ("No model matched chat.utilitySmallModel override").
 */
function utilityModelValue(): string | undefined {
  const id = firstPickerId();
  return id ? `${MODEL_PROVIDER_VENDOR}/${id}` : undefined;
}
/**
 * Seed for new chat conversations (replaces Copilot's "Auto").
 * `resolveConfiguredModel` in vscode core matches the stored value
 * case-insensitively against `metadata.id`, so the bare (profile-encoded) id
 * resolves directly without the vendor prefix.
 */
function defaultModelValue(): string | undefined {
  return firstPickerId();
}

function getChatUtilitySettings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('chat');
}

function isUtilityModelValueSet(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * True when a stored `<vendor>/<id>` value names THIS provider but an id that
 * no profile provides any more — a slot left behind by a profile/model edit
 * or removal. Repairing it is always safe (the value is ours, so no other
 * extension's choice can be clobbered), and leaving it breaks every helper
 * request with "No model matched chat.utilitySmallModel override".
 */
function isStaleOwnModelValue(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith(`${MODEL_PROVIDER_VENDOR}/`)) {
    return false;
  }
  const id = value.slice(MODEL_PROVIDER_VENDOR.length + 1).toLowerCase();
  return !readProfiles().some(
    (profile) => encodePickerId(profile.key, profile.model).toLowerCase() === id
  );
}

/**
 * The same staleness test for `chat.defaultModel`, which stores the BARE
 * picker id (no vendor prefix). Only values carrying our `::` encoding are
 * candidates — another provider's model id must never be rewritten.
 */
function isStalePickerId(value: unknown): boolean {
  if (typeof value !== 'string' || !value.includes('::')) {
    return false;
  }
  return !readProfiles().some(
    (profile) => encodePickerId(profile.key, profile.model).toLowerCase() === value.toLowerCase()
  );
}

/**
 * Point VS Code's BYOK/chat defaults at our own model unless the user has
 * already customized those settings themselves (their explicit choices win):
 * utility defaults for BYOK main models, plus the default model for NEW
 * conversations (in place of Copilot's "Auto").
 *
 * A no-op while no model is configured (there is nothing to point at).
 * Idempotent and fill-only: safe to call on every setup run and activation.
 */
export async function defaultChatUtilitySettingsToOwnModel(): Promise<void> {
  const utilityModel = utilityModelValue();
  const defaultModel = defaultModelValue();
  if (!utilityModel || !defaultModel) {
    return;
  }
  const config = getChatUtilitySettings();
  const byokDefault = config.inspect<string>(HOST_UTILITY_DEFAULT_SETTING)?.globalValue;
  if (byokDefault !== 'mainAgent') {
    await config.update(HOST_UTILITY_DEFAULT_SETTING, 'mainAgent', vscode.ConfigurationTarget.Global);
  }
  if (
    !isUtilityModelValueSet(config.inspect<unknown>(HOST_UTILITY_MODEL_SETTING)?.globalValue) ||
    isStaleOwnModelValue(config.inspect<unknown>(HOST_UTILITY_MODEL_SETTING)?.globalValue)
  ) {
    await config.update(HOST_UTILITY_MODEL_SETTING, utilityModel, vscode.ConfigurationTarget.Global);
  }
  if (
    !isUtilityModelValueSet(config.inspect<unknown>(HOST_UTILITY_SMALL_MODEL_SETTING)?.globalValue) ||
    isStaleOwnModelValue(config.inspect<unknown>(HOST_UTILITY_SMALL_MODEL_SETTING)?.globalValue)
  ) {
    await config.update(HOST_UTILITY_SMALL_MODEL_SETTING, utilityModel, vscode.ConfigurationTarget.Global);
  }
  // An empty string means "Auto (Vendor Default)" — treat it as unset. A
  // value naming a profile that no longer exists is repaired too.
  const defaultModelCurrent = config.inspect<string>('defaultModel')?.globalValue;
  if (!defaultModelCurrent?.trim() || isStalePickerId(defaultModelCurrent)) {
    await config.update('defaultModel', defaultModel, vscode.ConfigurationTarget.Global);
  }
  // Hide Copilot Chat's GitHub-sign-in-gated agent-session entries (see the
  // doc block above). Wrapped because the keys belong to the Copilot
  // extension: if its chat contribution is not active they may be
  // unregistered and update() can reject — a cosmetic default, never worth
  // failing the setup flow over.
  try {
    const ghChat = vscode.workspace.getConfiguration(GITHUB_COPILOT_CHAT_SECTION);
    if (ghChat.inspect<boolean>(HOST_BACKGROUND_AGENT_SETTING)?.globalValue === undefined) {
      await ghChat.update(HOST_BACKGROUND_AGENT_SETTING, false, vscode.ConfigurationTarget.Global);
    }
    if (ghChat.inspect<boolean>(HOST_CLOUD_AGENT_SETTING)?.globalValue === undefined) {
      await ghChat.update(HOST_CLOUD_AGENT_SETTING, false, vscode.ConfigurationTarget.Global);
    }
  } catch {
    // Non-fatal.
  }
}
