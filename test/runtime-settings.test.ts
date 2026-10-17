import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { SettingsManager, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { createRuntimeSettings } from "../src/harness/runtime-settings.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rsih-runtime-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agent, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const file = join(agent, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark", steeringMode: "all" }));
  return { root, agent, cwd, file };
}

test("runtime settings stay local across reload, preserve project priority and persist user preferences", async t => {
  const { agent, cwd, file } = fixture(t);
  mkdirSync(join(cwd, CONFIG_DIR_NAME));
  writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ followUpMode: "all" }));
  const runtime = createRuntimeSettings(agent);
  runtime.apply({ settings: { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" } });
  const originalCreate = SettingsManager.create;
  await runtime.run(async () => {
    const manager = SettingsManager.create(cwd, agent);
    assert.equal(manager.getSteeringMode(), "one-at-a-time");
    assert.equal(manager.getFollowUpMode(), "all", "project settings still outrank the Genome");
    manager.setTheme("light");
    manager.setSteeringMode("all");
    await manager.flush();
    const disk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(disk.theme, "light");
    assert.equal(disk.steeringMode, "all", "Genome overrides are not written to shared preferences");
    assert.equal(disk.$rsih, undefined);
    // Another process/user edit is visible on reload, while the Genome remains local.
    writeFileSync(file, JSON.stringify({ theme: "dark", steeringMode: "all", transport: "websocket" }));
    await manager.reload();
    assert.equal(manager.getSteeringMode(), "one-at-a-time");
    assert.equal(manager.getTransport(), "websocket");
    runtime.apply({ settings: { followUpMode: "one-at-a-time" } });
    await manager.reload();
    assert.equal(manager.getSteeringMode(), "all", "released keys restore user defaults");
  });
  assert.equal(SettingsManager.create, originalCreate);
});

test("runtime storage preserves other writers' nested preference changes", async t => {
  const { agent, cwd, file } = fixture(t);
  const runtime = createRuntimeSettings(agent);
  runtime.apply({ settings: { quietStartup: true } });
  await runtime.run(async () => {
    const a = SettingsManager.create(cwd, agent);
    const b = SettingsManager.create(cwd, agent);
    a.setModelThinkingLevel("provider", "model-a", "low");
    await a.flush();
    b.setModelThinkingLevel("provider", "model-b", "high");
    await b.flush();
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(Object.keys(stored.modelThinkingLevels).length, 2);
    assert.equal(stored.quietStartup, undefined);
  });
});

test("legacy managed values do not become user defaults, and invalid settings are preserved", async t => {
  const { agent, cwd, file } = fixture(t);
  const runtime = createRuntimeSettings(agent);
  writeFileSync(file, JSON.stringify({ theme: "dark", steeringMode: "all", $rsih: { managedKeys: ["steeringMode"] } }));
  await runtime.run(async () => {
    assert.equal(SettingsManager.create(cwd, agent).getSteeringMode(), "one-at-a-time");
  });
  writeFileSync(file, "{broken-json");
  await runtime.run(async () => {
    const manager = SettingsManager.create(cwd, agent);
    assert.ok(manager.drainErrors().length > 0);
    manager.setTheme("light");
    await manager.flush();
    assert.equal(readFileSync(file, "utf8"), "{broken-json");
  });
});

test("a project without settings gets no config directory, and a first write still lands", async t => {
  const { agent, cwd, file } = fixture(t);
  rmSync(file);
  const runtime = createRuntimeSettings(agent);
  runtime.apply({ settings: { steeringMode: "one-at-a-time" } });
  await runtime.run(async () => {
    const manager = SettingsManager.create(cwd, agent);
    assert.equal(manager.getSteeringMode(), "one-at-a-time");
    manager.setTheme("light");
    await manager.flush();
    assert.deepEqual(manager.drainErrors(), []);
  });
  assert.equal(existsSync(join(cwd, CONFIG_DIR_NAME)), false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "light");
});

test("an empty settings file reads as no preferences, like Pi", async t => {
  const { agent, cwd, file } = fixture(t);
  writeFileSync(file, "");
  const runtime = createRuntimeSettings(agent);
  runtime.apply({ settings: { steeringMode: "one-at-a-time" } });
  await runtime.run(async () => {
    const manager = SettingsManager.create(cwd, agent);
    assert.deepEqual(manager.drainErrors(), []);
    assert.equal(manager.getSteeringMode(), "one-at-a-time");
    manager.setTheme("light");
    await manager.flush();
  });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { theme: "light" });
});

test("the CLI factory bridge is restored after errors and leaves other agent directories alone", async t => {
  const { root, agent, cwd } = fixture(t);
  const original = SettingsManager.create;
  const runtime = createRuntimeSettings(agent);
  runtime.apply({ settings: { steeringMode: "all" } });
  await assert.rejects(runtime.run(async () => {
    assert.equal(SettingsManager.create(cwd, join(root, "other-agent")).getSteeringMode(), "one-at-a-time");
    throw new Error("synthetic failure");
  }), /synthetic failure/);
  assert.equal(SettingsManager.create, original);
});

test("keybindings reload reasserts the current Genome without changing the user's file", async t => {
  const { agent } = fixture(t);
  const piRoot = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { KeybindingsManager } = await import(pathToFileURL(join(piRoot, "core", "keybindings.js")).href);
  const file = join(agent, "keybindings.json");
  const original = JSON.stringify({ "app.session.tree": ["ctrl+g"] });
  writeFileSync(file, original);
  const runtime = createRuntimeSettings(agent);
  runtime.apply({ keybindings: { "app.session.tree": ["ctrl+t"] } });
  const manager = KeybindingsManager.create(agent);
  runtime.bindKeybindings(manager);
  assert.deepEqual(manager.getKeys("app.session.tree"), ["ctrl+t"]);
  manager.reload();
  assert.deepEqual(manager.getKeys("app.session.tree"), ["ctrl+t"]);
  runtime.apply({ keybindings: {} });
  manager.reload();
  assert.deepEqual(manager.getKeys("app.session.tree"), ["ctrl+g"]);
  assert.equal(readFileSync(file, "utf8"), original);
});


test("session snapshot reports the restored Genome projection, not RSIH base settings", t => {
  const { agent } = fixture(t);
  const runtime = createRuntimeSettings(agent);
  runtime.apply({
    settings: { quietStartup: true, steeringMode: "one-at-a-time" },
    snapshotSettings: { steeringMode: "one-at-a-time" },
    keybindings: { "app.session.tree": ["ctrl+t"] },
  });
  assert.deepEqual(runtime.snapshot(), {
    settings: { steeringMode: "one-at-a-time" },
    keybindings: { "app.session.tree": ["ctrl+t"] },
  });
  runtime.apply({
    settings: { quietStartup: true, steeringMode: "all" },
    snapshotSettings: { steeringMode: "all" },
    keybindings: {},
  });
  assert.deepEqual(runtime.snapshot(), { settings: { steeringMode: "all" }, keybindings: {} });
});
