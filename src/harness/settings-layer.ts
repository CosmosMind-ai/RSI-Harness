import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloneJson } from "../core/json.ts";

/** Marker key recording which Genome owns which settings in a generated file. */
export const RSIH_MANAGED_MARKER = "$rsih";

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    // A malformed file is Pi's to report; never clobber what we cannot read.
    return undefined;
  }
}

/**
 * Reassert the keys a Genome declares while leaving everything else alone.
 *
 * - Keys the Genome declares are replaced, so `--genome paperlab` always yields
 *   the same environment no matter what a previous run wrote.
 * - Keys the Genome does not declare are preserved, so Pi's own runtime writes
 *   (`theme`, `defaultModel`, `lastChangelogVersion`) survive.
 * - Keys a *previous* Genome managed but this one no longer declares are
 *   dropped, so switching Genomes does not leave residue behind.
 */
export function mergeManagedSettings(existing, patch, stamp) {
  const previous = existing?.[RSIH_MANAGED_MARKER]?.managedKeys ?? [];
  const managed = Object.keys(patch ?? {}).sort();
  const released = new Set(previous.filter((key) => !managed.includes(key)));

  const result = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (key === RSIH_MANAGED_MARKER || released.has(key)) continue;
    result[key] = value;
  }
  for (const key of managed) {
    result[key] = cloneJson(patch[key]);
  }
  if (managed.length > 0) {
    result[RSIH_MANAGED_MARKER] = { ...stamp, managedKeys: managed };
  }
  return result;
}

/**
 * Compile one Genome-managed JSON file under Pi's agent directory. Returns the
 * resolved contents so `rsih genome show` can render them without writing.
 */
export function compileManagedFile(path, patch, stamp, { write = true } = {}) {
  const existing = readJsonFile(path);
  if (existing === undefined) return undefined;

  const next = mergeManagedSettings(existing, patch, stamp);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (write && serialized !== `${JSON.stringify(existing, null, 2)}\n`) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serialized, "utf8");
  }
  return next;
}

/**
 * Apply a Genome's `settings` and `keybindings` projection to Pi's agent
 * directory. Pi has no API for injecting settings, so the compiled files are
 * the only place this can land.
 */
export function applyManagedConfiguration({
  agentDirectory,
  settings,
  keybindings,
  stamp,
  write = true,
}) {
  return {
    settings: compileManagedFile(
      join(agentDirectory, "settings.json"),
      settings ?? {},
      stamp,
      { write },
    ),
    keybindings: compileManagedFile(
      join(agentDirectory, "keybindings.json"),
      keybindings ?? {},
      stamp,
      { write },
    ),
  };
}
