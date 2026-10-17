/**
 * Pi sessions are append-only trees. A file's latest entry can belong to a
 * different branch from an earlier leaf, so resolve configuration through
 * parentId rather than scanning unrelated branches.
 */
import { contentHash } from "../core/json.ts";

export function sessionBranchEntries(entries, leafId) {
  const byId = new Map(
    entries.filter(entry => entry?.type !== "session" && typeof entry?.id === "string")
      .map(entry => [entry.id, entry]),
  );
  const last = leafId === undefined
    ? [...entries].reverse().find(entry => entry?.type !== "session" && typeof entry?.id === "string")?.id
    : leafId;
  const branch = [];
  const visited = new Set();
  for (let id = last; typeof id === "string" && byId.has(id) && !visited.has(id);) {
    const entry = byId.get(id);
    branch.push(entry);
    visited.add(id);
    id = entry.parentId;
  }
  return branch.reverse();
}

/**
 * A fork starts immediately before the selected entry; a clone includes it.
 * Resolve the retained ancestry, rather than reading the whole session file,
 * so a later Genome on another branch cannot influence the result.
 */
export function sessionForkBranchEntries(entries, entryId, position = "before") {
  const target = entries.find(entry => entry?.id === entryId);
  if (!target) return [];
  return sessionBranchEntries(
    entries,
    position === "at" ? entryId : (target.parentId ?? null),
  );
}

export function latestSessionGenome(entries) {
  return [...entries].reverse().find(
    entry => entry?.type === "custom" &&
      entry.customType === "rsih.genome" &&
      entry.data?.genome,
  )?.data;
}

export function sessionGenomeChanged(current, target) {
  if (!target?.genome) return false;
  return current.reference !== (target.reference ?? target.genome.genome_id) ||
    (target.baseDirectory !== undefined && current.baseDirectory !== target.baseDirectory) ||
    contentHash(current.genome) !== contentHash(target.genome);
}

/** Whether a startup-selected session needs its saved state reloaded in a fresh process. */
export function sessionNeedsRestore(current, storedGenome, currentSettings, storedSnapshot) {
  if (sessionGenomeChanged(current, storedGenome)) return true;
  if (!storedSnapshot) return false;
  return contentHash({ settings: currentSettings.settings, keybindings: currentSettings.keybindings }) !==
    contentHash({ settings: storedSnapshot.settings, keybindings: storedSnapshot.keybindings });
}
