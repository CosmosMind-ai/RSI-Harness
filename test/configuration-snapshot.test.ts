import assert from "node:assert/strict";
import test from "node:test";
import {
  computeConfigurationHash,
  createConfigurationSnapshot,
  configurationEquals,
  extractSnapshotFromEntry,
  findLatestSnapshot,
  shouldSaveSnapshot,
} from "../src/harness/configuration-snapshot.ts";

test("computeConfigurationHash produces stable hashes", () => {
  const settings = { theme: "dark", steeringMode: "one-at-a-time" };
  const keybindings = { "app.quit": ["ctrl+q"] };
  const stamp = { genome: "test", genomeId: "harness:test", rsih: "0.1.0" };

  const hash1 = computeConfigurationHash(settings, keybindings, stamp);
  const hash2 = computeConfigurationHash(settings, keybindings, stamp);

  assert.equal(hash1, hash2, "same configuration should produce same hash");
  assert.equal(typeof hash1, "string");
  assert.ok(hash1.length > 0);
});

test("computeConfigurationHash excludes unstable fields", () => {
  const base = { theme: "dark", steeringMode: "all" };
  const stamp = { genome: "test", rsih: "0.1.0" };

  const hash1 = computeConfigurationHash(
    { ...base, lastChangelogVersion: "1.0" },
    {},
    stamp,
  );
  const hash2 = computeConfigurationHash(
    { ...base, lastChangelogVersion: "2.0" },
    {},
    stamp,
  );

  assert.equal(hash1, hash2, "unstable fields should not affect hash");
});

test("computeConfigurationHash changes when stable fields change", () => {
  const stamp = { genome: "test", rsih: "0.1.0" };

  const hash1 = computeConfigurationHash({ theme: "dark" }, {}, stamp);
  const hash2 = computeConfigurationHash({ theme: "light" }, {}, stamp);

  assert.notEqual(hash1, hash2, "different stable fields should produce different hashes");
});

test("createConfigurationSnapshot produces valid snapshots", () => {
  const settings = { theme: "dark" };
  const keybindings = { "app.quit": ["ctrl+q"] };
  const stamp = { genome: "test", genomeId: "harness:test", rsih: "0.1.0" };

  const snapshot = createConfigurationSnapshot(settings, keybindings, stamp);

  assert.equal(typeof snapshot.hash, "string");
  assert.deepEqual(snapshot.settings, settings);
  assert.deepEqual(snapshot.keybindings, keybindings);
  assert.deepEqual(snapshot.stamp, stamp);
});

test("configurationEquals compares snapshots correctly", () => {
  const snapshot1 = createConfigurationSnapshot(
    { theme: "dark" },
    {},
    { genome: "test", rsih: "0.1.0" },
  );
  const snapshot2 = createConfigurationSnapshot(
    { theme: "dark" },
    {},
    { genome: "test", rsih: "0.1.0" },
  );
  const snapshot3 = createConfigurationSnapshot(
    { theme: "light" },
    {},
    { genome: "test", rsih: "0.1.0" },
  );

  assert.ok(configurationEquals(snapshot1, snapshot2), "same configuration should be equal");
  assert.ok(!configurationEquals(snapshot1, snapshot3), "different configuration should not be equal");
  assert.ok(!configurationEquals(snapshot1, undefined), "snapshot vs undefined should not be equal");
  assert.ok(!configurationEquals(undefined, snapshot1), "undefined vs snapshot should not be equal");
});

test("extractSnapshotFromEntry extracts valid snapshots", () => {
  const snapshot = createConfigurationSnapshot(
    { theme: "dark" },
    { "app.quit": ["ctrl+q"] },
    { genome: "test", rsih: "0.1.0" },
  );

  const entry = {
    type: "custom",
    customType: "rsih.configuration",
    data: snapshot,
  };

  const extracted = extractSnapshotFromEntry(entry);
  assert.ok(extracted);
  assert.equal(extracted.hash, snapshot.hash);
  assert.deepEqual(extracted.settings, snapshot.settings);
  assert.deepEqual(extracted.keybindings, snapshot.keybindings);
  assert.deepEqual(extracted.stamp, snapshot.stamp);
});

test("extractSnapshotFromEntry returns undefined for invalid entries", () => {
  assert.equal(extractSnapshotFromEntry({ type: "session" }), undefined);
  assert.equal(extractSnapshotFromEntry({ type: "custom", customType: "other" }), undefined);
  assert.equal(extractSnapshotFromEntry({ type: "custom", customType: "rsih.configuration" }), undefined);
  assert.equal(
    extractSnapshotFromEntry({
      type: "custom",
      customType: "rsih.configuration",
      data: { hash: "test" },
    }),
    undefined,
  );
});

test("findLatestSnapshot finds most recent snapshot", () => {
  const snapshot1 = createConfigurationSnapshot({ theme: "dark" }, {}, { genome: "v1" });
  const snapshot2 = createConfigurationSnapshot({ theme: "light" }, {}, { genome: "v2" });

  const entries = [
    { type: "session", data: {} },
    { type: "custom", customType: "rsih.configuration", data: snapshot1 },
    { type: "message", data: {} },
    { type: "custom", customType: "rsih.configuration", data: snapshot2 },
    { type: "custom", customType: "other", data: {} },
  ];

  const latest = findLatestSnapshot(entries);
  assert.ok(latest);
  assert.equal(latest.hash, snapshot2.hash);
  assert.deepEqual(latest.settings, snapshot2.settings);
});

test("findLatestSnapshot returns undefined for empty or no snapshots", () => {
  assert.equal(findLatestSnapshot([]), undefined);
  assert.equal(
    findLatestSnapshot([
      { type: "session", data: {} },
      { type: "message", data: {} },
    ]),
    undefined,
  );
});

test("shouldSaveSnapshot returns true when no previous snapshot exists", () => {
  const snapshot = createConfigurationSnapshot(
    { theme: "dark" },
    {},
    { genome: "test" },
  );

  assert.ok(shouldSaveSnapshot(snapshot, undefined));
});

test("shouldSaveSnapshot returns false when configuration matches", () => {
  const snapshot1 = createConfigurationSnapshot(
    { theme: "dark" },
    {},
    { genome: "test", rsih: "0.1.0" },
  );
  const snapshot2 = createConfigurationSnapshot(
    { theme: "dark" },
    {},
    { genome: "test", rsih: "0.1.0" },
  );

  assert.ok(!shouldSaveSnapshot(snapshot1, snapshot2));
});

test("shouldSaveSnapshot returns true when configuration differs", () => {
  const snapshot1 = createConfigurationSnapshot(
    { theme: "dark" },
    {},
    { genome: "test" },
  );
  const snapshot2 = createConfigurationSnapshot(
    { theme: "light" },
    {},
    { genome: "test" },
  );

  assert.ok(shouldSaveSnapshot(snapshot1, snapshot2));
});

test("shouldSaveSnapshot returns false for empty configuration with no previous snapshot", () => {
  const emptySnapshot = createConfigurationSnapshot({}, {}, {});
  assert.ok(!shouldSaveSnapshot(emptySnapshot, undefined));
});

test("shouldSaveSnapshot excludes unstable fields in comparison", () => {
  const snapshot1 = createConfigurationSnapshot(
    { theme: "dark", lastChangelogVersion: "1.0", timestamp: "2024-01-01" },
    {},
    { genome: "test" },
  );
  const snapshot2 = createConfigurationSnapshot(
    { theme: "dark", lastChangelogVersion: "2.0", timestamp: "2024-01-02" },
    {},
    { genome: "test" },
  );

  assert.ok(!shouldSaveSnapshot(snapshot1, snapshot2), "unstable fields should not trigger new snapshot");
});
