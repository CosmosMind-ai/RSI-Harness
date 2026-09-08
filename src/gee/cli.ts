#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Importing the rsih entry sets PI_PACKAGE_DIR, RSIH_CODING_AGENT_DIR and the
// version-check opt-out in one place. `gee` must not duplicate that setup.
import { runCli } from "../cli.ts";
import { expandGenomeShorthand } from "../cli/genome-shorthand.ts";

const GENOME = "harness-rsi";

/**
 * `gee` is `rsih --genome harness-rsi`. It starts the same interactive session,
 * whose job is to author a Genome from the user's own session history.
 *
 * The historical `harness-rsi` subcommand is accepted and dropped, since it is
 * now the only thing `gee` does. An explicit `--genome` wins — including the
 * `:name` / `+name` shorthand, which is expanded first — so `gee` stays usable
 * as a plain rsih alias.
 */
export function geeArgs(argv) {
  const stripped = argv[0] === "harness-rsi" ? argv.slice(1) : [...argv];
  const args = expandGenomeShorthand(stripped);
  const spec = args.findIndex(
    (arg) => arg === "--spec" || arg.startsWith("--spec="),
  );
  if (spec !== -1) {
    throw new Error(
      "gee no longer takes --spec. Genome authoring is interactive now: run `gee` (or `rsih --genome harness-rsi`) and answer the questions.",
    );
  }
  const hasGenome = args.some(
    (arg) => arg === "--genome" || arg.startsWith("--genome="),
  );
  return hasGenome ? args : ["--genome", GENOME, ...args];
}

export async function runGeeCli(argv = process.argv.slice(2)) {
  return runCli(geeArgs(argv));
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runGeeCli().catch((error) => {
    console.error(`gee: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
