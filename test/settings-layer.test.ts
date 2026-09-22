import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyManagedConfiguration,
  mergeManagedSettings,
  RSIH_MANAGED_MARKER,
} from "../src/harness/settings-layer.ts";
import { projectGenomeSettings } from "../src/harness/pi-projection.ts";
import { createHarnessGenome, loadHarnessGenomeFile } from "../src/index.ts";

const STAMP = { genome: "coding", genomeId: "harness:coding", rsih: "0.1.0" };

test("managed settings reassert Genome keys and preserve everything else", () => {
  const merged = mergeManagedSettings(
    {
      theme: "dark",
      trackingId: "abc",
      compaction: { reserveTokens: 1000 },
      [RSIH_MANAGED_MARKER]: { managedKeys: ["compaction"] },
    },
    { compaction: { reserveTokens: 24000 }, steeringMode: "all" },
    STAMP,
  );

  // Genome-declared keys are replaced, not deep-merged with stale values.
  assert.deepEqual(merged.compaction, { reserveTokens: 24000 });
  assert.equal(merged.steeringMode, "all");
  // Pi's own runtime writes survive untouched.
  assert.equal(merged.theme, "dark");
  assert.equal(merged.trackingId, "abc");
  assert.deepEqual(merged[RSIH_MANAGED_MARKER].managedKeys, [
    "compaction",
    "steeringMode",
  ]);
});

test("switching Genomes releases keys the new Genome does not claim", () => {
  const merged = mergeManagedSettings(
    {
      theme: "dark",
      compaction: { reserveTokens: 1000 },
      steeringMode: "all",
      [RSIH_MANAGED_MARKER]: { managedKeys: ["compaction", "steeringMode"] },
    },
    { compaction: { reserveTokens: 9000 } },
    STAMP,
  );

  assert.deepEqual(merged.compaction, { reserveTokens: 9000 });
  assert.equal("steeringMode" in merged, false);
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged[RSIH_MANAGED_MARKER].managedKeys, ["compaction"]);
});

test("a Genome that manages nothing leaves the file unmarked", () => {
  const merged = mergeManagedSettings({ theme: "dark" }, {}, STAMP);
  assert.deepEqual(merged, { theme: "dark" });
});

test("compiling writes both Pi configuration files", () => {
  const agentDirectory = mkdtempSync(join(tmpdir(), "rsih-agent-"));
  writeFileSync(
    join(agentDirectory, "settings.json"),
    JSON.stringify({ theme: "dark" }),
    "utf8",
  );

  applyManagedConfiguration({
    agentDirectory,
    settings: { quietStartup: true, steeringMode: "all" },
    keybindings: { "app.session.tree": ["ctrl+t"] },
    stamp: STAMP,
  });

  const settings = JSON.parse(
    readFileSync(join(agentDirectory, "settings.json"), "utf8"),
  );
  assert.equal(settings.theme, "dark");
  assert.equal(settings.steeringMode, "all");
  assert.equal(settings[RSIH_MANAGED_MARKER].genome, "coding");

  const keybindings = JSON.parse(
    readFileSync(join(agentDirectory, "keybindings.json"), "utf8"),
  );
  assert.deepEqual(keybindings["app.session.tree"], ["ctrl+t"]);
});

for (const contents of [
  '[\n  {"theme": "dark"}\n]\n',
  "null\n",
  '"dark"\n',
  "42\n",
  "true\n",
  '{"theme":\n',
]) {
  test(`compiling preserves invalid configuration contents: ${contents.trim()}`, (t) => {
    const agentDirectory = mkdtempSync(join(tmpdir(), "rsih-invalid-config-"));
    t.after(() => rmSync(agentDirectory, { recursive: true, force: true }));
    const paths = ["settings.json", "keybindings.json"].map((name) =>
      join(agentDirectory, name),
    );
    for (const path of paths) writeFileSync(path, contents, "utf8");

    const result = applyManagedConfiguration({
      agentDirectory,
      settings: { quietStartup: true },
      keybindings: { "app.session.tree": ["ctrl+t"] },
      stamp: STAMP,
    });

    for (const path of paths) {
      assert.equal(readFileSync(path, "utf8"), contents);
    }
    assert.deepEqual(result, { settings: undefined, keybindings: undefined });
  });
}

test("semantic Genome fields project onto Pi settings", () => {
  const projection = projectGenomeSettings(
    createHarnessGenome({
      runtime: { steering_mode: "all", follow_up_mode: "all" },
      policies: { compaction: { reserveTokens: 24000 } },
      model: { cycle: ["anthropic/*"] },
      appearance: { theme: "dark" },
    }),
  );

  assert.deepEqual(projection.settings, {
    steeringMode: "all",
    followUpMode: "all",
    compaction: { reserveTokens: 24000 },
    enabledModels: ["anthropic/*"],
    theme: "dark",
  });
});

test("the raw settings component overrides semantic routes", () => {
  const projection = projectGenomeSettings(
    createHarnessGenome({
      runtime: { steering_mode: "all" },
      settings: { steeringMode: "one-at-a-time" },
    }),
  );
  assert.equal(projection.settings.steeringMode, "one-at-a-time");
});

test("unknown settings keys and keybinding ids are rejected at load time", () => {
  assert.throws(
    () => createHarnessGenome({ settings: { steerringMode: "all" } }),
    /cannot configure "steerringMode"/,
  );
  assert.throws(
    () => createHarnessGenome({ settings: { trackingId: "abc" } }),
    /cannot configure "trackingId"/,
  );
  assert.throws(
    () => createHarnessGenome({ keybindings: { "app.session.treee": "ctrl+t" } }),
    /unknown binding id "app\.session\.treee"/,
  );
  assert.throws(
    () => createHarnessGenome({ keybindings: { "app.session.tree": [] } }),
    /must be a key or a non-empty array/,
  );
});

test("the checked-in paperlab Genome declares only what it configures", () => {
  const loaded = loadHarnessGenomeFile(
    join(import.meta.dirname, "..", "config", "genomes", "paperlab", "genome.json"),
  );
  assert.deepEqual(loaded.components.map((component) => component.id), [
    "instructions",
    "skills",
    "commands",
    "resources",
  ]);
  assert.equal(loaded.genome.genome_id, "harness:paperlab");
  const projection = projectGenomeSettings(loaded.genome);
  // The shipped example declares no settings or keybindings component: it
  // manages none of Pi's settings, so everything it leaves out inherits the
  // Pi default untouched.
  assert.deepEqual(projection.settings, {});
  assert.deepEqual(projection.keybindings, {});
});
