import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  PI_KEYBINDING_IDS,
  PI_RUNTIME_OWNED_SETTINGS,
  PI_SETTINGS_KEYS,
} from "../src/harness/pi-surface.ts";
import { GENOME_SETTINGS_ROUTES } from "../src/harness/pi-projection.ts";

const PI_DIST = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
);

function block(path, startPattern) {
  const source = readFileSync(join(PI_DIST, path), "utf8");
  const start = source.indexOf(startPattern);
  assert.notEqual(start, -1, `${startPattern} not found in ${path}`);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end);
}

/**
 * These two tests are the guard rail behind "a Genome can configure anything Pi
 * can". When a Pi upgrade adds a settings key or keybinding, they fail until the
 * new knob is either routed into a Genome component or explicitly exempted.
 */
test("Pi's settings keys are all reachable from a Genome", () => {
  const declared = new Set(
    [...block("core/settings-manager.d.ts", "export interface Settings {")
      .matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)]
      .map((match) => match[1]),
  );

  const known = new Set(PI_SETTINGS_KEYS);
  assert.deepEqual(
    [...declared].filter((key) => !known.has(key)),
    [],
    "Pi added settings keys; add them to PI_SETTINGS_KEYS or exempt them.",
  );
  assert.deepEqual(
    [...known].filter((key) => !declared.has(key)),
    [],
    "PI_SETTINGS_KEYS lists keys Pi no longer accepts.",
  );

  // Everything except Pi's own install state is Genome-configurable.
  assert.deepEqual(
    PI_SETTINGS_KEYS.filter((key) => !(key in PI_RUNTIME_OWNED_SETTINGS)).length,
    PI_SETTINGS_KEYS.length - Object.keys(PI_RUNTIME_OWNED_SETTINGS).length,
  );
});

test("Pi's keybinding ids are all reachable from a Genome", () => {
  const declared = [
    ...block("core/keybindings.d.ts", "export declare const KEYBINDINGS: {")
      .matchAll(/readonly "([a-zA-Z][a-zA-Z.]*)":/g),
  ].map((match) => match[1]);

  assert.ok(declared.length > 50, "keybinding extraction found too few ids");
  assert.deepEqual(
    declared.filter((id) => !PI_KEYBINDING_IDS.includes(id)),
    [],
    "Pi added keybindings; add them to PI_KEYBINDING_IDS.",
  );
  assert.deepEqual(
    PI_KEYBINDING_IDS.filter((id) => !declared.includes(id)),
    [],
    "PI_KEYBINDING_IDS lists ids Pi no longer accepts.",
  );
});

test("semantic Genome routes target real Pi settings", () => {
  assert.deepEqual(
    GENOME_SETTINGS_ROUTES.filter((key) => !PI_SETTINGS_KEYS.includes(key)),
    [],
  );
});
