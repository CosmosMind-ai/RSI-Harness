import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  configurationEquals,
  createConfigurationSnapshot,
  findLatestSnapshot,
  sessionBranchEntries,
} from "../src/harness/configuration-snapshot.ts";
import { createSessionConfiguration } from "../src/harness/session-configuration.ts";

const snapshot = mode => createConfigurationSnapshot({ steeringMode: mode }, { "app.session.tree": ["ctrl+y"] });

test("snapshot identity is stable, independent of metadata, and detached from its inputs", () => {
  const settings = { retry: { enabled: true, maxRetries: 2 }, steeringMode: "all" };
  const first = createConfigurationSnapshot(settings, {}, { rsih: "old" });
  const second = createConfigurationSnapshot({ steeringMode: "all", retry: { maxRetries: 2, enabled: true } }, {}, { rsih: "new" });
  assert.equal(first.hash, second.hash);
  settings.retry.maxRetries = 9;
  assert.equal(first.settings.retry.maxRetries, 2);
  assert.equal(configurationEquals(first, createConfigurationSnapshot(settings)), false);
  assert.equal(configurationEquals(first, { ...second, hash: "legacy-version-sensitive-hash" }), true);
});

test("snapshot lookup follows the selected ancestry and skips malformed records", () => {
  const entries = [
    { type: "custom", id: "a", parentId: null, customType: "rsih.configuration", data: snapshot("all") },
    { type: "message", id: "a-leaf", parentId: "a" },
    { type: "custom", id: "b", parentId: "a", customType: "rsih.configuration", data: snapshot("one-at-a-time") },
    { type: "custom", id: "bad", parentId: "b", customType: "rsih.configuration", data: { settings: null, keybindings: [] } },
  ];
  assert.equal(findLatestSnapshot(sessionBranchEntries(entries, "a-leaf"))?.settings.steeringMode, "all");
  assert.equal(findLatestSnapshot(sessionBranchEntries(entries))?.settings.steeringMode, "one-at-a-time");
  assert.equal(findLatestSnapshot([]), undefined);
  assert.deepEqual(sessionBranchEntries(entries, null), []);
});

function fixture(t, preferCurrentOnStartup = false) {
  const root = mkdtempSync(join(tmpdir(), "rsih-configuration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const configuration = createSessionConfiguration({
    agentDirectory: agent,
    baseSettings: { quietStartup: true },
    projection: snapshot("all"), stamp: {}, preferCurrentOnStartup,
  });
  configuration.apply(snapshot("all"));
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry("rsih.configuration", snapshot("one-at-a-time"));
  const handlers = new Map();
  const commands = new Map();
  let reloads = 0;
  const settings = SettingsManager.create(cwd, agent);
  const ctx = {
    sessionManager: manager,
    async reload() { reloads++; await settings.reload(); },
  };
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(name, data) { manager.appendCustomEntry(name, data); },
    sendUserMessage(message) { void commands.get(message.slice(1)).handler("", ctx); },
  };
  configuration.bind(pi);
  return { root, cwd, agent, configuration, manager, handlers, settings, ctx, pi, reloads: () => reloads };
}

test("startup picker restores saved settings before recording, while explicit Genome wins", async t => {
  const f = fixture(t);
  assert.equal(await f.configuration.start(f.pi, { reason: "startup" }, f.ctx), true);
  assert.equal(f.settings.getSteeringMode(), "one-at-a-time");
  assert.equal(f.reloads(), 1);
  f.configuration.save(f.pi, f.manager.getBranch());
  assert.equal(f.manager.getEntries().filter(entry => entry.customType === "rsih.configuration").length, 1);
  const explicit = fixture(t, true);
  assert.equal(await explicit.configuration.start(explicit.pi, { reason: "startup" }, explicit.ctx), false);
  explicit.configuration.save(explicit.pi, explicit.manager.getBranch());
  assert.equal(findLatestSnapshot(explicit.manager.getBranch())?.settings.steeringMode, "all");
});

test("tree navigation reloads changed configuration once and leaves unchanged/default navigation alone", async t => {
  const f = fixture(t);
  await f.handlers.get("session_tree")({}, f.ctx);
  assert.equal(f.settings.getSteeringMode(), "one-at-a-time");
  assert.equal(f.reloads(), 1);
  await f.handlers.get("session_tree")({}, f.ctx);
  assert.equal(f.reloads(), 1);
  assert.equal(f.manager.getEntries().filter(entry => entry.customType === "rsih.branch").length, 1);
  assert.equal(JSON.parse(readFileSync(join(f.agent, "keybindings.json"), "utf8"))["app.session.tree"][0], "ctrl+y");
  const legacy = SessionManager.inMemory();
  await f.handlers.get("session_tree")({}, { sessionManager: legacy });
  assert.equal(f.reloads(), 1);
});

test("fork and clone restore the configuration on their retained side of the boundary", t => {
  const f = fixture(t);
  const before = f.manager.getLeafId();
  f.manager.appendCustomEntry("rsih.configuration", snapshot("all"));
  const boundary = f.manager.getLeafId();
  const fork = f.handlers.get("session_before_fork");
  fork({ entryId: boundary, position: "before" }, f.ctx);
  assert.equal(SettingsManager.create(process.cwd(), f.agent).getSteeringMode(), "one-at-a-time");
  fork({ entryId: boundary, position: "at" }, f.ctx);
  assert.equal(SettingsManager.create(process.cwd(), f.agent).getSteeringMode(), "all");
  assert.equal(findLatestSnapshot(sessionBranchEntries(f.manager.getEntries(), before))?.settings.steeringMode, "one-at-a-time");
});

test("resume restores a saved patch while user preferences and project priority survive", t => {
  const f = fixture(t);
  const source = join(f.root, "history.jsonl");
  writeFileSync(source, JSON.stringify({ type: "custom", id: "saved", parentId: null,
    customType: "rsih.configuration", data: snapshot("one-at-a-time") }) + "\n");
  const file = join(f.agent, "settings.json");
  const existing = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...existing, theme: "light" }));
  f.handlers.get("session_before_switch")({ reason: "resume", targetSessionFile: source });
  const disk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(disk.steeringMode, "one-at-a-time");
  assert.equal(disk.theme, "light");
  assert.equal(disk.quietStartup, true);
  mkdirSync(join(f.cwd, CONFIG_DIR_NAME));
  writeFileSync(join(f.cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ steeringMode: "all" }));
  assert.equal(SettingsManager.create(f.cwd, f.agent).getSteeringMode(), "all");
  f.configuration.save(f.pi, []);
  assert.equal(findLatestSnapshot(f.manager.getBranch())?.settings.quietStartup, undefined);
  f.handlers.get("session_before_switch")({ reason: "new" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).steeringMode, "one-at-a-time");
});
