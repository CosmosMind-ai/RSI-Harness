/**
 * The process boundary a full Genome switch has to cross.
 *
 * Most of a Genome can be swapped inside a running Pi session; three things
 * cannot, because Pi reads them from argv exactly once: `extensions`,
 * `resources.isolate`, and a base `system_prompt` that replaces Pi's own
 * preamble. The only way to switch those is to be a new process.
 *
 * So the interactive launcher is a supervisor. It spawns the real agent as a
 * child sharing its terminal, and waits. A normal `/quit` ends both. A
 * `/switch-genome` ends the child through Pi's own quit path -- the code that
 * already knows how to hand a terminal back -- after leaving a request file
 * behind; the supervisor reads it and starts the child again on the same
 * session file under the new Genome. The conversation is on disk the whole
 * time, and the depth is always exactly two, however many switches happen.
 *
 * Non-interactive runs are not supervised. A print run has nothing to switch
 * and an RPC run is being driven by another program that would lose its
 * stream if the process changed; those modes switch in-session instead.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Set on the child so it knows a supervisor is waiting to restart it. */
export const SUPERVISED_ENV = "RSIH_SUPERVISED";
/** Set on a restarted child so it can tell the user and the model why. */
export const SWITCHED_FROM_ENV = "RSIH_SWITCHED_FROM";
const REQUEST_FILE = ".switch-genome.json";

/**
 * Whether this invocation would reach Pi's interactive mode. Mirrors the
 * decision Pi makes: a terminal on both ends and no one-shot or RPC flag.
 */
export function wantsInteractive(argv, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (argv[0] === "genome") return false;
  for (const [index, argument] of argv.entries()) {
    if (argument === "-p" || argument === "--print" || argument === "--json") return false;
    if (argument === "--mode" && argv[index + 1] !== undefined) return false;
    if (argument.startsWith("--mode=")) return false;
    if (argument === "--help" || argument === "-h" || argument === "--version" || argument === "-v") {
      return false;
    }
    if (argument === "--list-models") return false;
  }
  return true;
}

function requestPath(agentDirectory) {
  return join(agentDirectory, REQUEST_FILE);
}

/**
 * Written by the child just before it asks Pi to quit. Synchronous on purpose:
 * Pi's shutdown ends the process, so the write has to be complete first.
 */
export function writeSwitchRequest(agentDirectory, request) {
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(requestPath(agentDirectory), `${JSON.stringify(request)}\n`, "utf8");
}

/** Read and remove the request, so a crash later can never replay it. */
export function takeSwitchRequest(agentDirectory) {
  const path = requestPath(agentDirectory);
  if (!existsSync(path)) return undefined;
  let request;
  try {
    request = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    request = undefined;
  } finally {
    rmSync(path, { force: true });
  }
  return request && typeof request.reference === "string" ? request : undefined;
}

/** Options that name the Genome or the session; the restart supplies both. */
const REPLACED_OPTIONS = new Set([
  "--genome",
  "--session",
  "--session-id",
  "--run-id",
  "--fork",
]);
const REPLACED_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--new"]);

/**
 * The argv for the restarted child: everything the user typed, minus how they
 * originally chose a Genome and a session, plus the switch's own answer to both.
 */
export function restartArgv(argv, request) {
  const kept = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (REPLACED_FLAGS.has(argument)) continue;
    const [name] = argument.split("=", 1);
    if (REPLACED_OPTIONS.has(name)) {
      if (!argument.includes("=")) index += 1;
      continue;
    }
    kept.push(argument);
  }
  const session = request.sessionFile ? ["--session", request.sessionFile] : [];
  return ["--genome", request.reference, ...session, ...kept];
}

/**
 * A switch is something a person typed, so real ones are seconds apart at the
 * very least. Restarts arriving faster than this are a loop, and a supervisor
 * that keeps a broken child spinning on someone's terminal is worse than one
 * that stops and says so.
 */
const RESTART_WINDOW_MS = 10_000;
const MAX_RESTARTS_PER_WINDOW = 5;

/**
 * Run the agent as a supervised child until it exits without asking to be
 * restarted. Resolves with the exit code the supervisor itself should use.
 */
export async function supervise({
  command,
  baseArgs,
  argv,
  agentDirectory,
  env = process.env,
  spawnChild = spawn,
  now = Date.now,
  stderr = process.stderr,
}) {
  let currentArgv = argv;
  let switchedFrom;
  const recentRestarts = [];
  // Ctrl-C reaches the child directly through the shared terminal; the
  // supervisor's only job on a signal is to stay alive long enough to see the
  // child's answer to it.
  const ignore = () => {};
  process.on("SIGINT", ignore);

  try {
    for (;;) {
      const childEnv = { ...env, [SUPERVISED_ENV]: "1" };
      if (switchedFrom) childEnv[SWITCHED_FROM_ENV] = switchedFrom;
      else delete childEnv[SWITCHED_FROM_ENV];

      const child = spawnChild(command, [...baseArgs, ...currentArgv], {
        stdio: "inherit",
        env: childEnv,
      });
      const forward = (signal) => () => {
        if (child.exitCode === null) child.kill(signal);
      };
      const onTerm = forward("SIGTERM");
      const onHup = forward("SIGHUP");
      process.on("SIGTERM", onTerm);
      process.on("SIGHUP", onHup);

      const outcome = await new Promise((resolve) => {
        child.on("error", (error) => resolve({ error }));
        child.on("exit", (code, signal) => resolve({ code, signal }));
      });
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);

      if (outcome.error) throw outcome.error;

      const request = takeSwitchRequest(agentDirectory);
      if (request && outcome.signal === null) {
        const at = now();
        while (recentRestarts.length > 0 && at - recentRestarts[0] > RESTART_WINDOW_MS) {
          recentRestarts.shift();
        }
        recentRestarts.push(at);
        if (recentRestarts.length > MAX_RESTARTS_PER_WINDOW) {
          stderr.write(
            `rsih: refusing to restart again -- ${recentRestarts.length} Genome switches in ${RESTART_WINDOW_MS / 1000}s. ` +
              `Last request: ${request.reference}.\n`,
          );
          return 1;
        }
        currentArgv = restartArgv(currentArgv, request);
        switchedFrom = request.from ?? undefined;
        continue;
      }
      if (outcome.signal) {
        // Die the way the child did, so a caller's `$?` reads the same.
        process.kill(process.pid, outcome.signal);
        return 128;
      }
      return outcome.code ?? 0;
    }
  } finally {
    process.off("SIGINT", ignore);
  }
}
