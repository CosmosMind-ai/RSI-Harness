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
