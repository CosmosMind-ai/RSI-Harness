import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rsih-session-config-"));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  mkdirSync(cwd);
  const profiles = join(root, "providers.json");
  writeFileSync(profiles, JSON.stringify({ mock: { kind: "mock", model: "snapshot-test", mock_responses: ["ok"] } }));
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_OFFLINE: "1", PI_TELEMETRY: "0", RSIH_CODING_AGENT_DIR: agent };
  const args = [join(repo, "src", "cli.ts"), "--offline", "--cwd", cwd, "--config", profiles];
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    rmSync(root, { recursive: true, force: true });
  });
  const genome = (name, mode, key) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify({ genome_schema_version: "2", genome_id: `harness:${name}`,
      model: { profile: "mock", id: "snapshot-test" },
      settings: { steeringMode: mode }, keybindings: { "app.session.tree": [key] } }));
    return path;
  };
  return { root, cwd, agent, args, env, genome, clients };
}

function rpc(f, extra = []) {
  const child = spawn(process.execPath, [...f.args, "--mode", "rpc", ...extra],
    { cwd: f.cwd, env: f.env, stdio: "pipe", windowsHide: true });
  const pending = new Map();
  const reader = createInterface({ input: child.stdout });
  let serial = 0;
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  reader.on("line", line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type !== "response" || !pending.has(event.id)) return;
    const request = pending.get(event.id);
    pending.delete(event.id);
    clearTimeout(request.timer);
    if (event.success) request.resolve(event.data);
    else request.reject(new Error(JSON.stringify(event)));
  });
  child.on("exit", code => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`CLI exited ${code}: ${errors}`));
    }
    pending.clear();
  });
  const client = {
    request(command) {
      return new Promise<any>((resolve, reject) => {
        const id = String(++serial);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${JSON.stringify(command)} ${errors}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exited;
      reader.close();
    },
  };
  f.clients.push(client);
  return client;
}

async function complete(client, message) {
  const previous = (await client.request({ type: "get_state" })).messageCount;
  await client.request({ type: "prompt", message });
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await client.request({ type: "get_state" });
    if (!state.isStreaming && state.messageCount > previous) return state;
    await delay(25);
  }
  throw new Error("Mock turn did not complete");
}

const entries = path => readFileSync(path, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
const snapshots = path => entries(path).filter(entry => entry.customType === "rsih.configuration");
const binding = agent => JSON.parse(readFileSync(join(agent, "keybindings.json"), "utf8"))["app.session.tree"];

test("CLI restores snapshots on resume and fork, honors explicit adoption, and avoids duplicates", { timeout: 90000 }, async t => {
  const f = fixture(t);
  const manifest = f.genome("demo", "one-at-a-time", "ctrl+y");
  let client = rpc(f, ["--genome", manifest]);
  const first = await complete(client, "First configuration.");
  await client.close();
  assert.equal(snapshots(first.sessionFile).length, 1);
  assert.equal(snapshots(first.sessionFile)[0].data.settings.quietStartup, undefined);
  f.genome("demo", "all", "ctrl+u");
  client = rpc(f, ["--session", first.sessionFile]);
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "one-at-a-time");
  assert.deepEqual(binding(f.agent), ["ctrl+y"]);
  await complete(client, "Continue frozen configuration.");
  await client.close();
  assert.equal(snapshots(first.sessionFile).length, 1);
  client = rpc(f, ["--fork", first.sessionFile]);
  const fork = await complete(client, "Forked configuration.");
  assert.notEqual(fork.sessionFile, first.sessionFile);
  assert.equal(fork.steeringMode, "one-at-a-time");
  await client.close();
  client = rpc(f, ["--session", first.sessionFile, "--genome", manifest]);
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "all");
  await complete(client, "Adopt the edited configuration.");
  await client.close();
  assert.equal(snapshots(first.sessionFile).length, 2);
  client = rpc(f, ["--session", first.sessionFile]);
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "all");
  assert.deepEqual(binding(f.agent), ["ctrl+u"]);
  await client.request({ type: "switch_session", sessionPath: fork.sessionFile });
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "one-at-a-time");
  assert.deepEqual(binding(f.agent), ["ctrl+y"]);
  await client.close();
  client = rpc(f, ["--continue"]);
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "all");
});

test("RPC tree, clone and fork use the retained branch's settings and keybindings", { timeout: 90000 }, async t => {
  const f = fixture(t);
  const a = f.genome("first", "one-at-a-time", "ctrl+y");
  const b = f.genome("second", "all", "ctrl+u");
  const observer = join(f.root, "tree.ts");
  writeFileSync(observer, `export default function(pi) {
    pi.registerCommand("snapshot-tree", { description: "Navigate to a selected entry", async handler(args, ctx) {
      await ctx.navigateTree(args.trim(), { summarize: false });
    } });
  }`);
  const client = rpc(f, ["--genome", a, "--extension", observer]);
  const first = await complete(client, "First branch.");
  const firstLeaf = entries(first.sessionFile).at(-1).id;
  await client.request({ type: "prompt", message: `/switch-genome ${b}` });
  await complete(client, "Second branch.");
  const secondLeaf = entries(first.sessionFile).at(-1).id;
  await client.request({ type: "prompt", message: `/snapshot-tree ${firstLeaf}` });
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "one-at-a-time");
  assert.deepEqual(binding(f.agent), ["ctrl+y"]);
  await complete(client, "Continue first branch.");
  await client.request({ type: "prompt", message: `/snapshot-tree ${secondLeaf}` });
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "all");
  assert.deepEqual(binding(f.agent), ["ctrl+u"]);
  assert.equal(snapshots(first.sessionFile).length, 2);
  await client.request({ type: "clone" });
  const cloned = await client.request({ type: "get_state" });
  assert.notEqual(cloned.sessionFile, first.sessionFile);
  assert.equal(cloned.steeringMode, "all");
  const forkMessages = (await client.request({ type: "get_fork_messages" })).messages;
  const firstMessage = forkMessages.find(entry => entry.text === "First branch.");
  assert.ok(firstMessage);
  await client.request({ type: "fork", entryId: firstMessage.entryId });
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "one-at-a-time");
  assert.deepEqual(binding(f.agent), ["ctrl+y"]);
});

test("print mode preserves project overrides and resumes legacy sessions without snapshots", { timeout: 60000 }, t => {
  const f = fixture(t);
  const manifest = f.genome("project", "one-at-a-time", "ctrl+y");
  mkdirSync(join(f.cwd, ".rsih"));
  writeFileSync(join(f.cwd, ".rsih", "settings.json"), JSON.stringify({ steeringMode: "all" }));
  const file = join(f.root, "history.jsonl");
  const run = extra => spawnSync(process.execPath, [...f.args, "--session", file, "-p", "Hello.", ...extra],
    { cwd: f.cwd, env: f.env, encoding: "utf8", input: "", timeout: 30000, windowsHide: true });
  const first = run(["--genome", manifest]);
  assert.equal(first.status, 0, first.stderr);
  const saved = snapshots(file)[0].data;
  assert.equal(saved.settings.steeringMode, "one-at-a-time");
  const legacy = entries(file).filter(entry => entry.customType !== "rsih.configuration");
  // Remove the snapshot while keeping Pi's ancestry intact.
  const removed = snapshots(file)[0];
  for (const entry of legacy) if (entry.parentId === removed.id) entry.parentId = removed.parentId;
  writeFileSync(file, legacy.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const resumed = run([]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(snapshots(file).length, 1);
});

test("a snapshot selected during startup rebuilds the actual runtime before accepting prompts", { timeout: 60000 }, async t => {
  const f = fixture(t);
  const manifest = f.genome("picker", "one-at-a-time", "ctrl+y");
  let client = rpc(f, ["--genome", manifest]);
  const first = await complete(client, "Saved configuration.");
  await client.close();
  const selection = join(f.root, "selection.ts");
  writeFileSync(selection, `export default function(pi) {
    pi.on("session_start", (event) => {
      if (event.reason === "startup") pi.appendEntry("rsih.configuration", {
        settings: { steeringMode: "all" }, keybindings: { "app.session.tree": ["ctrl+u"] }, stamp: {}
      });
    });
  }`);
  client = rpc(f, ["--session", first.sessionFile, "--extension", selection]);
  assert.equal((await client.request({ type: "get_state" })).steeringMode, "all");
  assert.deepEqual(binding(f.agent), ["ctrl+u"]);
  await complete(client, "Use the selected configuration.");
  assert.equal(snapshots(first.sessionFile).length, 2);
});
