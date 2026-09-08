#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expandGenomeShorthand } from "./cli/genome-shorthand.ts";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDirectory = process.versions.bun
  ? dirname(process.execPath)
  : projectDirectory;
process.env.PI_PACKAGE_DIR ??= packageDirectory;
process.env.RSIH_CODING_AGENT_DIR ??= resolve(
  process.env.HOME ?? packageDirectory,
  ".rsih",
);
// RSIH is a standalone distribution, so Pi's upstream self-update check would
// compare the RSIH package version with Pi releases and advertise `rsih update`.
process.env.PI_SKIP_VERSION_CHECK ??= "1";

export async function runCli(argv = process.argv.slice(2)) {
  const { runPiCli } = await import("./pi-cli-runtime.ts");
  return runPiCli(expandGenomeShorthand(argv));
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runCli().catch((error) => {
    console.error(`rsih: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
