import assert from "node:assert/strict";
import test from "node:test";
import { createConfigurationSnapshot, findLatestSnapshot } from "../src/harness/configuration-snapshot.ts";
import { latestSessionGenome, sessionBranchEntries, sessionGenomeChanged } from "../src/harness/session-configuration.ts";

function snapshot(settings) {
  return createConfigurationSnapshot(settings, {}, { genome: "demo", rsih: "0.1.0" });
}

test("session snapshots only follow the active branch, not an unrelated later branch", () => {
  const a = snapshot({ steeringMode: "one-at-a-time" });
  const b = snapshot({ steeringMode: "all" });
  const entries = [
    { type: "session", id: "session-id" },
    { type: "custom", id: "root", parentId: null, customType: "rsih.configuration", data: a },
    { type: "message", id: "a1", parentId: "root" },
    { type: "custom", id: "b1", parentId: "root", customType: "rsih.configuration", data: b },
    { type: "message", id: "b2", parentId: "b1" },
    { type: "message", id: "a2", parentId: "a1" },
  ];
  const branchA = sessionBranchEntries(entries);
  assert.deepEqual(branchA.map(entry => entry.id), ["root", "a1", "a2"]);
  assert.equal(findLatestSnapshot(branchA)?.settings.steeringMode, "one-at-a-time");
  const branchB = sessionBranchEntries(entries, "b2");
  assert.deepEqual(branchB.map(entry => entry.id), ["root", "b1", "b2"]);
  assert.equal(findLatestSnapshot(branchB)?.settings.steeringMode, "all");
});

test("frozen Genome lookup follows session branches and detects content updates", () => {
  const original = { genome_id: "harness:demo", version: 1, settings: { steeringMode: "all" } };
  const updated = { ...original, settings: { steeringMode: "one-at-a-time" } };
  const entries = [
    { type: "custom", id: "root", parentId: null, customType: "rsih.genome",
      data: { reference: "demo", baseDirectory: "/genomes", genome: original } },
    { type: "custom", id: "other", parentId: "root", customType: "rsih.genome",
      data: { reference: "demo", baseDirectory: "/genomes", genome: updated } },
    { type: "message", id: "active", parentId: "root" },
  ];
  const target = latestSessionGenome(sessionBranchEntries(entries));
  assert.equal(target.genome.settings.steeringMode, "all");
  const current = { reference: "demo", baseDirectory: "/genomes", genome: original };
  assert.equal(sessionGenomeChanged(current, target), false);
  assert.equal(sessionGenomeChanged({ ...current, genome: updated }, target), true);
  assert.equal(sessionGenomeChanged({ ...current, reference: "other" }, target), true);
  assert.equal(sessionGenomeChanged({ ...current, baseDirectory: "/different" }, target), true);
  assert.equal(sessionGenomeChanged(current, undefined), false);
});

test("empty/legacy session without an active tree does not invent a snapshot", () => {
  assert.deepEqual(sessionBranchEntries([]), []);
  assert.deepEqual(sessionBranchEntries([{ type: "session", id: "header" }]), []);
  assert.deepEqual(sessionBranchEntries([{ type: "message", id: "entry", parentId: null }], null), []);
});
