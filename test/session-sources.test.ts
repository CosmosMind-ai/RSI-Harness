import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SOURCE_IDS,
  readSessions,
  SESSION_SOURCES,
} from "../config/genomes/harness-rsi/extension/session-sources.ts";

const cwd = "/workspace/研究 project";
const date = "2026-09-01T12:00:00.000Z";
const meta = { type: "session_meta", payload: { id: "fixture", cwd, timestamp: date, source: "cli" } };
const user = (message) => ({ type: "event_msg", payload: { type: "user_message", message } });
const piUser = (text) => ({ type: "message", message: { role: "user", content: text } });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rsih-source-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, entries, name = "session.jsonl") {
  const path = join(root, name);
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
}

function codex(roots) {
  const source = SESSION_SOURCES.find((source) => source.id === "codex");
  assert.ok(source, "Codex must be a supported, opt-in source");
  return source.read(roots);
}

function useCodexHome(t, root: string | undefined) {
  const previous = process.env.CODEX_HOME;
  if (root === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
}

test("Pi coverage accounts for message limits independently of text truncation", (t) => {
  const root = fixture(t);
  const header = { type: "session", cwd };
  for (const count of [39, 40, 41]) {
    write(root, [header, ...Array.from({ length: count }, (_, i) => piUser(`request ${i}`))]);
    const [record] = readSessions([], [root]).records;
    assert.equal(record.prompts.length, Math.min(count, 40));
    assert.equal(record.promptsComplete, count <= 40, `count=${count}`);
    assert.deepEqual(record.samplingIssues, count <= 40 ? [] : ["prompt_limit"]);
  }
  write(root, [header, piUser("x".repeat(601))]);
  const [record] = readSessions([], [root]).records;
  assert.equal(record.promptsComplete, true);
  assert.deepEqual(record.samplingIssues, ["prompt_truncated"]);
});

test("Claude prompt completeness accounts for the message limit", (t) => {
  const root = fixture(t);
  write(root, Array.from({ length: 41 }, (_, i) => ({
    type: "user", cwd, promptSource: "typed", message: { content: `request ${i}` },
  })));
  const [record] = SESSION_SOURCES.find((source) => source.id === "claude")!.read([root]);
  assert.equal(record.prompts.length, 40);
  assert.equal(record.promptsComplete, false);
  assert.deepEqual(record.samplingIssues, ["prompt_limit"]);
});

test("overlapping roots and symlink aliases count each transcript once", (t) => {
  const root = fixture(t);
  const child = join(root, "child");
  mkdirSync(child);
  write(child, [{ type: "session", cwd }, piUser("one request")]);
  // Directory junctions do not require Windows Developer Mode/admin rights.
  symlinkSync(child, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  const records = readSessions([], [root, child, root]).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].prompts.length, 1);
});

test("malformed lines are reported separately from sampling coverage", (t) => {
  const root = fixture(t);
  const path = write(root, [{ type: "session", cwd }, piUser("before")]);
  writeFileSync(path, '{broken}\nnull\n[]\n' + JSON.stringify(piUser("after")) + '\n{"type":', { flag: "a" });
  const [record] = readSessions([], [root]).records;
  assert.deepEqual(record.prompts, ["before", "after"]);
  assert.equal(record.promptsComplete, true);
  assert.deepEqual(record.samplingIssues, ["malformed_json"]);
});

test("Codex reads canonical user events without duplicating model-visible messages", (t) => {
  const root = fixture(t);
  cpSync(join(import.meta.dirname, "fixtures", "codex", "user-events.jsonl"), join(root, "rollout.jsonl"));
  const [record] = codex([root]);
  assert.equal(record.source, "codex");
  assert.equal(record.cwd, cwd);
  assert.equal(record.created.toISOString(), date);
  assert.deepEqual(record.prompts, ["Build a slide deck", "Build a slide deck", "<tag> is literal user input"]);
  assert.equal(record.promptsComplete, true);
  assert.deepEqual(record.samplingIssues, []);
});

test("Codex discovers dated and archived rollouts using CODEX_HOME only when selected", (t) => {
  const root = fixture(t);
  useCodexHome(t, root);
  const dated = join(root, "sessions", "2026", "09", "01");
  const archived = join(root, "archived_sessions");
  mkdirSync(dated, { recursive: true });
  mkdirSync(archived);
  write(dated, [meta, user("active")]);
  write(archived, [meta, user("archived")]);
  write(root, [user("history.jsonl must not be used")], "history.jsonl");
  assert.deepEqual(DEFAULT_SOURCE_IDS, ["rsih"]);
  assert.deepEqual(readSessions([]).records, []);
  const scan = readSessions(["codex"]);
  assert.equal(scan.sources[0].available, true);
  assert.equal(scan.records.length, 2);
  assert.deepEqual(scan.records.map((record) => record.prompts[0]).sort(), ["active", "archived"]);
});

test("Codex reads past 64 KiB of injected context with a larger bounded window", (t) => {
  const root = fixture(t);
  write(root, [meta, { type: "response_item", payload: { type: "message", role: "developer", content: "x".repeat(1100 * 1024) } }, user("late real request")]);
  const [record] = codex([root]);
  assert.deepEqual(record.prompts, ["late real request"]);
  assert.equal(record.promptsComplete, true);
});

test("Codex reports its byte limit instead of treating unseen prompts as absent", (t) => {
  const root = fixture(t);
  write(root, [meta, { type: "response_item", payload: { content: "x".repeat(3 * 1024 * 1024) } }, user("beyond the budget")]);
  const [record] = codex([root]);
  assert.deepEqual(record.prompts, []);
  assert.equal(record.promptsComplete, false);
  assert.ok(record.samplingIssues.includes("byte_limit"));
});

test("Codex rejects injected-only user messages as evidence and marks unsupported sampling", (t) => {
  const root = fixture(t);
  write(root, [meta, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md private instructions" }] } }]);
  const [record] = codex([root]);
  assert.deepEqual(record.prompts, []);
  assert.equal(record.promptsComplete, true);
  assert.ok(record.samplingIssues.includes("no_user_events"));
});

test("Codex skips subagent histories and files without valid metadata", (t) => {
  const root = fixture(t);
  write(root, [{ ...meta, payload: { ...meta.payload, source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } } } }, user("agent-generated instruction")], "child.jsonl");
  write(root, [user("missing session metadata")], "missing.jsonl");
  write(root, [{ ...meta, payload: { ...meta.payload, cwd: {} } }, user("invalid cwd")], "invalid.jsonl");
  assert.deepEqual(codex([root]), []);
});

test("Codex accepts CRLF and a complete final record without a newline", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "rollout.jsonl"), [meta, user("中文请求🙂")].map((entry) => JSON.stringify(entry)).join("\r\n"));
  const [record] = codex([root]);
  assert.deepEqual(record.prompts, ["中文请求🙂"]);
  assert.equal(record.promptsComplete, true);
});

test("Codex uses the default home when CODEX_HOME is unset", (t) => {
  useCodexHome(t, undefined);
  const source = SESSION_SOURCES.find((source) => source.id === "codex")!;
  // Inspect locations only; this test must not read the user's real history.
  assert.deepEqual(source.roots(), [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".codex", "archived_sessions"),
  ]);
});

test("Codex applies message and text limits to canonical events", (t) => {
  const root = fixture(t);
  write(root, [meta, user("x".repeat(601)), ...Array.from({ length: 40 }, () => user("again"))]);
  const [record] = codex([root]);
  assert.equal(record.prompts.length, 40);
  assert.equal(record.prompts[0].length, 603);
  assert.equal(record.promptsComplete, false);
  assert.deepEqual(record.samplingIssues.sort(), ["prompt_limit", "prompt_truncated"]);
});

test("Codex recovers later user events after malformed records", (t) => {
  const root = fixture(t);
  const path = write(root, [meta, user("before")]);
  writeFileSync(path, 'null\n{bad}\n' + JSON.stringify(user("after")) + '\n', { flag: "a" });
  const [record] = codex([root]);
  assert.deepEqual(record.prompts, ["before", "after"]);
  assert.deepEqual(record.samplingIssues, ["malformed_json"]);
});

test("Codex never parses a user record cut in the middle of a UTF-8 character", (t) => {
  const root = fixture(t);
  const opening = JSON.stringify(meta) + '\n' + JSON.stringify(user("before")) + '\n';
  const prefix = '{"type":"event_msg","payload":{"type":"user_message","message":"';
  const padding = 2 * 1024 * 1024 - Buffer.byteLength(opening + prefix) - 1;
  writeFileSync(join(root, "rollout.jsonl"), opening + prefix + 'a'.repeat(padding) + '汉"}}\n');
  const [record] = codex([root]);
  assert.deepEqual(record.prompts, ["before"]);
  assert.deepEqual(record.samplingIssues, ["byte_limit"]);
});

test("Codex counts unsupported files once even through overlapping custom roots", (t) => {
  const root = fixture(t);
  useCodexHome(t, root);
  const store = join(root, "sessions");
  mkdirSync(store);
  write(store, [meta, user("supported")]);
  writeFileSync(join(store, "archive.jsonl.zst"), "synthetic compressed placeholder");
  write(store, [user("missing metadata")], "missing.jsonl");
  write(store, [{ ...meta, payload: { ...meta.payload, base_instructions: { text: "x".repeat(3 * 1024 * 1024) } } }], "oversized-meta.jsonl");
  const scan = readSessions(["codex"], [store, store]);
  assert.equal(scan.records.length, 1);
  assert.equal(scan.records[0].source, "codex");
  assert.deepEqual(scan.skippedFiles, {
    filtered: 0, unreadable: 0, missing_metadata: 2, unsupported_format: 1,
  });
  assert.deepEqual(scan.sources[0].skippedFiles, scan.skippedFiles);
});

test("Codex keeps distinct forks separate and excludes explicitly internal threads", (t) => {
  const root = fixture(t);
  write(root, [meta, user("shared request")], "parent.jsonl");
  write(root, [{ ...meta, payload: { ...meta.payload, id: "fork", forked_from_id: "fixture" } }, user("shared request")], "fork.jsonl");
  write(root, [{ ...meta, payload: { ...meta.payload, thread_source: "memory_consolidation" } }, user("internal instruction")], "internal.jsonl");
  const records = codex([root]);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.prompts[0] === "shared request"));
});


test("Codex distinguishes exactly 40 prompts from a later nonempty 41st event", (t) => {
  const root = fixture(t);
  for (const count of [39, 40, 41]) {
    write(root, [meta, ...Array.from({ length: count }, (_, i) => user(`request ${i}`)),
      user("  "), { type: "response_item", payload: { role: "user", content: "mirror" } }]);
    const [record] = codex([root]);
    assert.equal(record.prompts.length, Math.min(count, 40));
    assert.equal(record.promptsComplete, count <= 40);
    assert.deepEqual(record.samplingIssues, count <= 40 ? [] : ["prompt_limit"]);
  }
  write(root, [meta, ...Array.from({ length: 40 }, () => user("request")),
    user("  "), { type: "event_msg", payload: { type: "user_message", message: null } }, user("41st")]);
  const [record] = codex([root]);
  assert.equal(record.promptsComplete, false);
  assert.deepEqual(record.samplingIssues, ["malformed_json", "prompt_limit"]);
});

test("Codex text truncation alone preserves coverage", (t) => {
  const root = fixture(t);
  write(root, [meta, user("x".repeat(601))]);
  const [record] = codex([root]);
  assert.equal(record.promptsComplete, true);
  assert.deepEqual(record.samplingIssues, ["prompt_truncated"]);
});

test("Codex waits for late metadata before stopping or filtering", (t) => {
  const root = fixture(t);
  const requests = Array.from({ length: 41 }, () => user("request"));
  write(root, [...requests, meta]);
  const [record] = codex([root]);
  assert.equal(record.cwd, cwd);
  assert.equal(record.prompts.length, 40);
  assert.deepEqual(record.samplingIssues, ["prompt_limit"]);
  write(root, [...requests, { ...meta, payload: { ...meta.payload, source: "subagent" } }]);
  assert.deepEqual(codex([root]), []);
});

test("Codex reports each skip reason separately and deduplicates filtered files", (t) => {
  const root = fixture(t);
  useCodexHome(t, root);
  const store = join(root, "sessions");
  mkdirSync(store);
  write(store, [meta, user("human")]);
  write(store, [{ ...meta, payload: { ...meta.payload, source: "internal" } }], "internal.jsonl");
  write(store, [user("no metadata")], "missing.jsonl");
  writeFileSync(join(store, "unsupported.jsonl.zst"), "synthetic placeholder");
  mkdirSync(join(store, "directory.jsonl"));
  symlinkSync(store, join(root, "archived_sessions"), process.platform === "win32" ? "junction" : "dir");
  const scan = readSessions(["codex"], [store, store]);
  assert.equal(scan.records.length, 1);
  assert.deepEqual(scan.skippedFiles, {
    filtered: 1, unreadable: 1, missing_metadata: 1, unsupported_format: 1,
  });
  assert.deepEqual(scan.sources[0].skippedFiles, scan.skippedFiles);
});

test("Pi and Claude cwd fallback never interprets a line cut by the byte window", (t) => {
  const root = fixture(t);
  const prefix = '{"cwd":"/must-not-be-used","padding":"';
  writeFileSync(join(root, "cut.jsonl"), prefix + "x".repeat(64 * 1024) + '"}\n');
  assert.deepEqual(readSessions([], [root]).records, []);
  const claude = SESSION_SOURCES.find((source) => source.id === "claude")!;
  assert.deepEqual(claude.read([root]), []);
});

test("a file appended during the read uses the initial size snapshot", (t) => {
  const root = fixture(t);
  const path = write(root, [meta, user("before")]);
  const originalRead = fs.readSync;
  let appended = false;
  t.mock.method(fs, "readSync", (...args) => {
    const count = Reflect.apply(originalRead, fs, args);
    if (!appended) {
      appended = true;
      writeFileSync(path, JSON.stringify(user("appended later")) + "\n", { flag: "a" });
    }
    return count;
  });
  syncBuiltinESMExports();
  try {
    const [record] = codex([root]);
    assert.deepEqual(record.prompts, ["before"]);
    assert.equal(record.promptsComplete, true);
    assert.deepEqual(record.samplingIssues, []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("read errors are counted as unreadable and the file descriptor is closed", (t) => {
  const root = fixture(t);
  useCodexHome(t, root);
  const store = join(root, "sessions");
  mkdirSync(store);
  write(store, [meta, user("request")]);
  let descriptor: number | undefined;
  t.mock.method(fs, "readSync", (fd) => {
    descriptor = fd;
    throw new Error("synthetic I/O failure");
  });
  syncBuiltinESMExports();
  try {
    const scan = readSessions(["codex"]);
    assert.deepEqual(scan.records, []);
    assert.deepEqual(scan.skippedFiles, {
      filtered: 0, unreadable: 1, missing_metadata: 0, unsupported_format: 0,
    });
    assert.notEqual(descriptor, undefined);
    assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("Codex preserves Windows drive and UNC workspace paths", (t) => {
  const root = fixture(t);
  const paths = [String.raw`C:\Users\Example\研究 project`, String.raw`\\server\share\project`];
  paths.forEach((path, i) => write(root, [
    { ...meta, payload: { ...meta.payload, cwd: path } }, user("request"),
  ], `${i}.jsonl`));
  assert.deepEqual(codex([root]).map((record) => record.cwd).sort(), paths.sort());
});
