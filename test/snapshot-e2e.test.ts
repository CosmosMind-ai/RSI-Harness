import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test("configuration snapshot end-to-end: save and restore", { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "rsih-e2e-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agent, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const profiles = join(root, "profiles.json");
  writeFileSync(profiles, JSON.stringify({
    mock: { kind: "mock", model: "test-model", mock_responses: ["response1", "response2"] }
  }));

  const genome = join(root, "genome.json");
  writeFileSync(genome, JSON.stringify({
    genome_schema_version: "2",
    genome_id: "harness:e2e-test",
    version: 1,
    model: { profile: "mock", id: "test-model" },
    settings: { steeringMode: "one-at-a-time", theme: "dark" },
  }));

  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    RSIH_CODING_AGENT_DIR: agent,
  };

  // First run - should create snapshot
  const run1 = spawnSync(
    process.execPath,
    [
      join(repo, "src", "cli.ts"),
      "--mode", "rpc",
      "--offline",
      "--cwd", cwd,
      "--genome", genome,
      "--config", profiles,
    ],
    {
      cwd,
      env,
      input: JSON.stringify({ id: "1", type: "prompt", message: "test" }) + "\n" +
             JSON.stringify({ id: "2", type: "get_state" }) + "\n",
      encoding: "utf8",
      timeout: 30000,
    }
  );

  if (run1.error) throw run1.error;
  assert.equal(run1.status, 0, `First run failed: ${run1.stderr}`);

  const responses1 = run1.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const state1 = responses1.find(r => r.id === "2" && r.success)?.data;
  assert.ok(state1, "Should get state from first run");
  const sessionFile = state1.sessionFile;
  assert.ok(sessionFile, "Should have session file");

  // Verify snapshot was saved
  const sessionContent = readFileSync(sessionFile, "utf8");
  const entries = sessionContent.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const snapshotEntry = entries.find(e => e.type === "custom" && e.customType === "rsih.configuration");

  assert.ok(snapshotEntry, "Snapshot should be saved");
  assert.equal(snapshotEntry.data.settings.steeringMode, "one-at-a-time");
  assert.equal(typeof snapshotEntry.data.hash, "string");
  console.log("✓ Snapshot saved correctly");

  // Modify genome
  writeFileSync(genome, JSON.stringify({
    genome_schema_version: "2",
    genome_id: "harness:e2e-test",
    version: 1,
    model: { profile: "mock", id: "test-model" },
    settings: { steeringMode: "all", theme: "light" }, // Changed!
  }));

  // Resume session - should use snapshot, not modified genome
  const run2 = spawnSync(
    process.execPath,
    [
      join(repo, "src", "cli.ts"),
      "--mode", "rpc",
      "--offline",
      "--cwd", cwd,
      "--session", sessionFile,
      "--config", profiles,
    ],
    {
      cwd,
      env,
      input: JSON.stringify({ id: "3", type: "get_state" }) + "\n",
      encoding: "utf8",
      timeout: 30000,
    }
  );

  if (run2.error) throw run2.error;
  assert.equal(run2.status, 0, `Resume run failed: ${run2.stderr}`);

  const responses2 = run2.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const state2 = responses2.find(r => r.id === "3" && r.success)?.data;
  assert.ok(state2, "Should get state from resume");
  assert.equal(state2.steeringMode, "one-at-a-time", "Should use snapshot settings, not modified genome");
  console.log("✓ Snapshot restored correctly on resume");

  // Verify no duplicate snapshot was created
  const sessionContent2 = readFileSync(sessionFile, "utf8");
  const snapshotCount = sessionContent2.split(/\r?\n/).filter(line => {
    try {
      const entry = JSON.parse(line);
      return entry.type === "custom" && entry.customType === "rsih.configuration";
    } catch {
      return false;
    }
  }).length;
  assert.equal(snapshotCount, 1, "Should not create duplicate snapshot");
  console.log("✓ No duplicate snapshot created");
});
