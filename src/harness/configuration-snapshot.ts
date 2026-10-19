import { cloneJson, contentHash } from "../core/json.ts";

export interface ConfigurationSnapshot {
  hash: string;
  settings: Record<string, unknown>;
  keybindings: Record<string, unknown>;
  stamp: Record<string, unknown>;
}

export function createConfigurationSnapshot(settings = {}, keybindings = {}, stamp = {}): ConfigurationSnapshot {
  return {
    hash: contentHash({ settings, keybindings }),
    settings: cloneJson(settings),
    keybindings: cloneJson(keybindings),
    stamp: cloneJson(stamp),
  };
}

export function configurationEquals(left, right) {
  return Boolean(left && right) &&
    contentHash({ settings: left.settings, keybindings: left.keybindings }) ===
    contentHash({ settings: right.settings, keybindings: right.keybindings });
}

export function findLatestSnapshot(entries): ConfigurationSnapshot | undefined {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "rsih.configuration") continue;
    const data = entry.data;
    if (object(data) && object(data.settings) && object(data.keybindings)) {
      // Recompute identity so metadata and older hash formats do not create duplicates.
      return createConfigurationSnapshot(data.settings, data.keybindings, object(data.stamp) ? data.stamp : {});
    }
  }
  return undefined;
}

/** Resolve only the selected ancestry of Pi's append-only session tree. */
export function sessionBranchEntries(entries, leafId = undefined) {
  const byId = new Map(entries.filter(entry => entry.type !== "session").map(entry => [entry.id, entry]));
  let id = leafId === undefined ? entries.at(-1)?.id : leafId;
  const branch = [];
  const visited = new Set();
  while (typeof id === "string" && byId.has(id) && !visited.has(id)) {
    const entry = byId.get(id);
    visited.add(id);
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}
