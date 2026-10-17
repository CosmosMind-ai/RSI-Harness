import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { cloneJson } from "../core/json.ts";

/** Marker key recording which Genome owns which settings in a generated file. */
export const RSIH_MANAGED_MARKER = "$rsih";

function parseJsonFile(contents) {
  if (contents === undefined) return {};
  try {
    const parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    // A malformed file is Pi's to report; never clobber what we cannot read.
    return undefined;
  }
}

function lockConfigurationFile(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      if (error.code !== "ELOCKED" || attempt === 9) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/**
 * Use Pi's lock convention for shared preferences; publish complete JSON files.
 * Like Pi's own storage, a missing file gets no directory and no lock until
 * something is written: reading `<cwd>/.rsih/settings.json` must not create `.rsih/`.
 */
export function withConfigurationFile(path, update) {
  let release = existsSync(path) ? lockConfigurationFile(path) : undefined;
  let temporary;
  try {
    const current = release ? readFileSync(path, "utf8") : undefined;
    const next = update(current);
    if (next !== undefined && next !== current) {
      if (!release) {
        mkdirSync(dirname(path), { recursive: true });
        release = lockConfigurationFile(path);
      }
      temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, next, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    }
  } finally {
    if (temporary) rmSync(temporary, { force: true });
    release?.();
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
  let result;
  const compile = (contents) => {
    const existing = parseJsonFile(contents);
    if (existing === undefined) return undefined;
    result = mergeManagedSettings(existing, patch, stamp);
    return write ? `${JSON.stringify(result, null, 2)}\n` : undefined;
  };
  if (write) withConfigurationFile(path, compile);
  else compile(existsSync(path) ? readFileSync(path, "utf8") : undefined);
  return result;
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
