/**
 * The profile LIST — every configured group of (endpoint + alias + model +
 * limits) — kept in the USER-LEVEL credential store (`context.secrets`)
 * instead of `settings.json`.
 *
 * WHY THIS MODULE EXISTS. `vscode.workspace.getConfiguration()` is scoped to
 * the VS Code PROFILE (the window profile behind "Profiles: Switch Profile"),
 * while `context.secrets` is the ONE store VS Code scopes to the APPLICATION.
 * A BYOK setup is a property of this MACHINE, not of a window profile: a group
 * added while working in one VS Code profile must be visible in all of them.
 * A settings-based list would be per profile AND would carry the endpoint in
 * plain text — keys and endpoints both belong in the credential store.
 *
 * STORAGE LAYOUT (both slots application-scoped, so every profile reads and
 * writes the same values):
 *   `customModel.profiles.v2`        JSON array of Profile rows (this module)
 *   `customModel.apiKey.<profileKey>` that group's API key (config.ts)
 *
 * WHY A CACHE. Provider discovery, host-default repair and the wizard all read
 * the list synchronously and repeatedly; SecretStorage is async. So:
 *   - `initProfileStore(context)` fills the cache ONCE at activation,
 *   - `reloadProfiles()` refills it when ANOTHER window writes (see
 *     `secrets.onDidChange` in extension.ts), and
 *   - every writer updates the cache before it writes, so a read right after
 *     a write never sees the previous list (the wizard's post-save summary,
 *     the picker re-query and `chat.defaultModel` repair all depend on it).
 *
 * `initProfileStore` never throws: on a host where SecretStorage is
 * unavailable the store degrades to memory-only — groups added in this window
 * work for the session and are not persisted — and one line in the output
 * channel says why.
 */
import * as vscode from 'vscode';
import { modelOutput, parseProfile, type Profile } from './config';

/**
 * SecretStorage slot holding the JSON array. Versioned so a future shape
 * change can migrate instead of guessing at an unknown payload.
 */
export const PROFILES_SECRET_KEY = 'customModel.profiles.v2';

/** Application-scoped store, set by {@link initProfileStore}. */
let store: vscode.SecretStorage | undefined;

/** The in-memory list every synchronous reader sees. */
let cache: Profile[] = [];

/** True once the store (or the memory-only fallback) has been read. */
let ready = false;

/**
 * Serialized payload this window last read or wrote. `secrets.onDidChange`
 * fires for our OWN writes too; comparing the payload keeps a no-op event
 * (identical content) from re-querying the picker and re-running host repair.
 */
let lastPayload = '';

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/** A stored payload → validated rows (duplicate keys dropped, bad rows skipped). */
function parseStored(raw: string): Profile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const profiles: Profile[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const profile = parseProfile(item);
    if (!profile || seen.has(profile.key)) {
      continue;
    }
    seen.add(profile.key);
    profiles.push(profile);
  }
  return profiles;
}

/**
 * Load the list into the cache. Called ONCE from activation, before the model
 * provider is registered and before any host-default repair reads it. An
 * absent slot is written as `[]` so "store initialized" and "no groups
 * configured" stay distinguishable from "not read yet".
 */
export async function initProfileStore(context: vscode.ExtensionContext): Promise<void> {
  store = context.secrets;
  try {
    const raw = await store.get(PROFILES_SECRET_KEY);
    if (raw === undefined) {
      await store.store(PROFILES_SECRET_KEY, '[]');
      cache = [];
      lastPayload = '[]';
      ready = true;
      return;
    }
    cache = parseStored(raw);
    lastPayload = raw;
    ready = true;
  } catch (err) {
    // No SecretStorage (or a rejected read): degrade to memory-only. Groups
    // still work for this session; nothing is persisted until a healthy
    // window writes the shared store.
    store = undefined;
    ready = false;
    modelOutput().appendLine(`[profiles] credential store unavailable — ${String(err)}`);
  }
}

/**
 * Every configured group. Synchronous by design (see the module doc block).
 * Before {@link initProfileStore} ran — a unit test, or a window whose
 * SecretStorage read failed — the list is empty; callers need no "not
 * initialized yet" branch.
 */
export function readProfiles(): Profile[] {
  return cache;
}

export function readProfile(key: string): Profile | undefined {
  return readProfiles().find((profile) => profile.key === key);
}

export function firstProfile(): Profile | undefined {
  return readProfiles()[0];
}

/** True once the shared store is the source of truth in this window. */
export function isProfileStoreReady(): boolean {
  return ready && store !== undefined;
}

/**
 * Persist the whole list: cache first (a read straight after this call must
 * see the new value), then the store (skipped in the memory-only degradation —
 * the session keeps working either way), then the listeners.
 */
export async function writeProfiles(profiles: readonly Profile[]): Promise<void> {
  const next = profiles.map((profile) => ({ ...profile }));
  cache = next;
  ready = true;
  const payload = JSON.stringify(next);
  if (store) {
    lastPayload = payload;
    await store.store(PROFILES_SECRET_KEY, payload);
  }
  notify();
}

/** Insert or replace one group (the wizard's save path, keyed by `profile.key`). */
export async function upsertProfile(profile: Profile): Promise<void> {
  const profiles = readProfiles();
  const index = profiles.findIndex((item) => item.key === profile.key);
  if (index >= 0) {
    profiles[index] = profile;
  } else {
    profiles.push(profile);
  }
  await writeProfiles(profiles);
}

export async function removeProfile(key: string): Promise<void> {
  await writeProfiles(readProfiles().filter((profile) => profile.key !== key));
}

/**
 * Re-read the shared store after ANOTHER window wrote it (`secrets.onDidChange`).
 *
 * Returns whether the effective list moved; a no-op event (our own write, or
 * an identical payload) returns `false` so the caller does not re-query the
 * model list for nothing. A read failure keeps the current cache.
 */
export async function reloadProfiles(): Promise<boolean> {
  if (!store) {
    return false;
  }
  let raw: string | undefined;
  try {
    raw = await store.get(PROFILES_SECRET_KEY);
  } catch {
    return false;
  }
  if (raw === undefined) {
    // Never cleared by this extension; a foreign delete is not a reason to
    // drop the list this window is serving requests from.
    return false;
  }
  if (raw === lastPayload) {
    return false;
  }
  cache = parseStored(raw);
  lastPayload = raw;
  ready = true;
  notify();
  return true;
}

/**
 * Persist a gear-panel limit override INTO ONE GROUP. Per field: `> 0` = store
 * it, `<= 0` = the box was cleared — restore "auto" (0). Returns whether
 * anything was written, so a value riding along on every request never churns
 * the credential store.
 */
export async function applyProfileLimitOverrides(
  profileKey: string,
  overrides: { maxInputTokens?: number; maxOutputTokens?: number }
): Promise<boolean> {
  const profiles = readProfiles();
  const index = profiles.findIndex((profile) => profile.key === profileKey);
  if (index < 0) {
    return false;
  }
  const current = profiles[index];
  const next = { ...current };
  let changed = false;
  for (const field of ['maxInputTokens', 'maxOutputTokens'] as const) {
    const value = overrides[field];
    if (value === undefined) {
      continue;
    }
    const resolved = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    if (next[field] !== resolved) {
      next[field] = resolved;
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  profiles[index] = next;
  await writeProfiles(profiles);
  return true;
}

/** Subscribe to effective-list changes (this window's writes + reloads). */
export function onProfilesChanged(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return {
    dispose(): void {
      listeners.delete(listener);
    },
  };
}

/** Test seam: forget the store, the cache and every listener. */
export function resetProfileStoreForTests(): void {
  store = undefined;
  cache = [];
  ready = false;
  lastPayload = '';
  listeners.clear();
}
