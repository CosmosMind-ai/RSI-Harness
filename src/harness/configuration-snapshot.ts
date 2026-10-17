/**
 * Configuration snapshot for session history.
 *
 * When a Genome's configuration (settings + keybindings) changes, we save a new
 * snapshot in the session history. This ensures:
 * 1. Resuming an old session restores the configuration it was created with
 * 2. We don't create duplicate snapshots when nothing changed
 * 3. Old sessions without snapshots remain compatible
 */

import { canonicalJson, cloneJson, contentHash } from "../core/json.ts";

export interface ConfigurationSnapshot {
  /** Stable hash of the configuration content */
  hash: string;
  /** Settings managed by the Genome */
  settings: Record<string, unknown>;
  /** Keybindings managed by the Genome */
  keybindings: Record<string, unknown>;
  /** Metadata stamp (genome reference, genomeId, rsih version) */
  stamp: {
    genome?: string;
    genomeId?: string;
    rsih?: string;
    [key: string]: unknown;
  };
}

/**
 * Compute a stable hash for a configuration.
 * Excludes unstable fields like timestamps, temporary paths, etc.
 */
export function computeConfigurationHash(
  settings: Record<string, unknown>,
  keybindings: Record<string, unknown>,
  stamp: Record<string, unknown>,
): string {
  // Clone to avoid modifying the original
  const stable = {
    settings: cloneJson(settings ?? {}),
    keybindings: cloneJson(keybindings ?? {}),
    stamp: cloneJson(stamp ?? {}),
  };

  // Remove unstable fields that shouldn't affect the hash
  const unstableKeys = [
    "lastChangelogVersion",
    "lastSeenVersion",
    "timestamp",
    "createdAt",
    "updatedAt",
  ];

  for (const key of unstableKeys) {
    delete stable.settings[key];
    delete stable.stamp[key];
  }

  // RSIH's release version is metadata, not part of the Genome configuration.
  delete stable.stamp.rsih;

  return contentHash(stable);
}

/**
 * Create a configuration snapshot.
 */
export function createConfigurationSnapshot(
  settings: Record<string, unknown>,
  keybindings: Record<string, unknown>,
  stamp: Record<string, unknown>,
): ConfigurationSnapshot {
  const hash = computeConfigurationHash(settings, keybindings, stamp);
  return {
    hash,
    settings: cloneJson(settings ?? {}),
    keybindings: cloneJson(keybindings ?? {}),
    stamp: cloneJson(stamp ?? {}),
  };
}

/**
 * Compare two configuration snapshots.
 * Returns true if they represent the same configuration.
 */
export function configurationEquals(
  a: ConfigurationSnapshot | undefined,
  b: ConfigurationSnapshot | undefined,
): boolean {
  if (!a || !b) return false;
  // Recompute using current semantics: older stored hashes included stamp.rsih.
  return computeConfigurationHash(a.settings, a.keybindings, a.stamp) ===
    computeConfigurationHash(b.settings, b.keybindings, b.stamp);
}

/**
 * Extract configuration snapshot from a session entry.
 * Returns undefined if the entry doesn't contain a valid snapshot.
 */
export function extractSnapshotFromEntry(entry: {
  type?: string;
  customType?: string;
  data?: unknown;
}): ConfigurationSnapshot | undefined {
  if (
    entry.type !== "custom" ||
    entry.customType !== "rsih.configuration"
  ) {
    return undefined;
  }

  const data = entry.data as any;
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.hash !== "string" ||
    typeof data.settings !== "object" ||
    typeof data.keybindings !== "object" ||
    typeof data.stamp !== "object"
  ) {
    return undefined;
  }

  return {
    hash: data.hash,
    settings: data.settings ?? {},
    keybindings: data.keybindings ?? {},
    stamp: data.stamp ?? {},
  };
}

/**
 * Find the most recent configuration snapshot in session entries.
 * Returns undefined if no snapshot is found (e.g., old sessions).
 */
export function findLatestSnapshot(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): ConfigurationSnapshot | undefined {
  // Iterate backwards to find the most recent snapshot
  for (let i = entries.length - 1; i >= 0; i--) {
    const snapshot = extractSnapshotFromEntry(entries[i]);
    if (snapshot) return snapshot;
  }
  return undefined;
}

/**
 * Check if a configuration has changed compared to the stored snapshot.
 * Returns true if:
 * - No snapshot exists (first run or old session) and configuration is non-empty
 * - Snapshot exists and hash differs
 *
 * Returns false if:
 * - Configuration matches the stored snapshot
 * - Both are empty
 */
export function shouldSaveSnapshot(
  current: ConfigurationSnapshot,
  stored: ConfigurationSnapshot | undefined,
): boolean {
  if (!stored) {
    // No previous snapshot - save if we have any configuration
    const hasSettings = Object.keys(current.settings).length > 0;
    const hasKeybindings = Object.keys(current.keybindings).length > 0;
    const hasStamp = Object.keys(current.stamp).length > 0;
    return hasSettings || hasKeybindings || hasStamp;
  }

  // Normalize legacy hashes before comparing, avoiding a one-time duplicate
  // when upgrading from a version that included stamp.rsih in the hash.
  return !configurationEquals(current, stored);
}
