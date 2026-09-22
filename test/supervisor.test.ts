import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SUPERVISED_ENV,
  SWITCHED_FROM_ENV,
  restartArgv,
  supervise,
  takeSwitchRequest,
  wantsInteractive,
  writeSwitchRequest,
} from "../src/cli/supervisor.ts";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("only a terminal on both ends with no one-shot flag is interactive", () => {
  const io = { stdin: tty, stdout: tty };
  assert.equal(wantsInteractive([], io), true);
  assert.equal(wantsInteractive(["--genome", "dev", "--cwd", "."], io), true);
  assert.equal(wantsInteractive([":paperlab"], io), true);

  assert.equal(wantsInteractive([], { stdin: pipe, stdout: tty }), false);
  assert.equal(wantsInteractive([], { stdin: tty, stdout: pipe }), false);
  assert.equal(wantsInteractive(["-p", "hi"], io), false);
  assert.equal(wantsInteractive(["--json"], io), false);
  assert.equal(wantsInteractive(["--mode", "rpc"], io), false);
  assert.equal(wantsInteractive(["--mode=rpc"], io), false);
  assert.equal(wantsInteractive(["genome", "list"], io), false);
  assert.equal(wantsInteractive(["--help"], io), false);
  assert.equal(wantsInteractive(["--list-models"], io), false);
});

test("a restart keeps the user's flags and replaces only Genome and session", () => {
  const request = { reference: "debate", sessionFile: "/s/a.jsonl" };
  assert.deepEqual(
    restartArgv(
      ["--genome", "dev", "--cwd", "/repo", "--run-id", "x", "--thinking", "high", "-c"],
      request,
    ),
    ["--genome", "debate", "--session", "/s/a.jsonl", "--cwd", "/repo", "--thinking", "high"],
  );
  // `--genome=dev` and a shorthand-expanded argv both collapse the same way.
  assert.deepEqual(restartArgv(["--genome=dev", "--new"], request), [
    "--genome",
    "debate",
    "--session",
    "/s/a.jsonl",
  ]);
  // Nothing to resume from: the restart still carries the new Genome.
  assert.deepEqual(restartArgv(["--genome", "dev"], { reference: "debate" }), [
    "--genome",
    "debate",
  ]);
});

test("a switch request is read exactly once and never survives a bad body", () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    assert.equal(takeSwitchRequest(directory), undefined);

    writeSwitchRequest(directory, { reference: "debate", sessionFile: "/s.jsonl", from: "dev" });
    assert.deepEqual(takeSwitchRequest(directory), {
      reference: "debate",
      sessionFile: "/s.jsonl",
      from: "dev",
    });
    assert.equal(takeSwitchRequest(directory), undefined);

    // A crash mid-write must not become a restart loop on the next launch.
    writeFileSync(join(directory, ".switch-genome.json"), "{not json", "utf8");
    assert.equal(takeSwitchRequest(directory), undefined);
    assert.equal(existsSync(join(directory, ".switch-genome.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A child that runs a script instead of a process: each entry is what one
 * spawn does before exiting. Lets the loop be tested without a terminal.
 */
function scriptedSpawn(script, calls) {
  return (command, args, options) => {
    const step = script[calls.length];
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {};
    setImmediate(() => {
      step?.before?.();
      child.exitCode = step?.code ?? 0;
      child.emit("exit", step?.code ?? 0, step?.signal ?? null);
    });
    return child;
  };
}

test("the supervisor restarts on a request and stops when there is none", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    const calls = [];
    const code = await supervise({
      command: "rsih",
      baseArgs: ["cli.ts"],
      argv: ["--genome", "dev", "--cwd", "/repo"],
      agentDirectory: directory,
      env: { HOME: "/home/u" },
      spawnChild: scriptedSpawn(
        [
          {
            before: () =>
              writeSwitchRequest(directory, {
                reference: "debate",
                sessionFile: "/s/a.jsonl",
                from: "dev",
              }),
          },
          { code: 0 },
        ],
        calls,
      ),
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ["cli.ts", "--genome", "dev", "--cwd", "/repo"]);
    assert.equal(calls[0].env[SUPERVISED_ENV], "1");
    assert.equal(SWITCHED_FROM_ENV in calls[0].env, false);

    assert.deepEqual(calls[1].args, [
      "cli.ts",
      "--genome",
      "debate",
      "--session",
      "/s/a.jsonl",
      "--cwd",
      "/repo",
    ]);
    assert.equal(calls[1].env[SWITCHED_FROM_ENV], "dev");
    // The user's environment reaches the child untouched.
    assert.equal(calls[1].env.HOME, "/home/u");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a child's exit code passes through when it did not ask to restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    const calls = [];
    const code = await supervise({
      command: "rsih",
      baseArgs: [],
      argv: [],
      agentDirectory: directory,
      env: {},
      spawnChild: scriptedSpawn([{ code: 3 }], calls),
    });
    assert.equal(code, 3);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a request left by a crash is honoured, but a restart storm is not", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-sup-"));
  try {
    const written = [];
    const stderr = { write: (text) => written.push(text) };
    let clock = 0;
    const calls = [];
    const file = () =>
      writeSwitchRequest(directory, { reference: "loop", sessionFile: "/s.jsonl" });
    const code = await supervise({
      command: "rsih",
      baseArgs: [],
      argv: [],
      agentDirectory: directory,
      env: {},
      now: () => (clock += 100),
      stderr,
      // Every run immediately asks to be restarted.
      spawnChild: scriptedSpawn(Array.from({ length: 20 }, () => ({ before: file })), calls),
    });
    assert.equal(code, 1);
    // Five restarts are allowed inside the window; the sixth is refused.
    assert.equal(calls.length, 6);
    assert.match(written.join(""), /refusing to restart/);
    assert.equal(existsSync(join(directory, ".switch-genome.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
