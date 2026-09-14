import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const executableName = process.platform === "win32" ? "rsih.exe" : "rsih";
const outputDirectory = resolve("dist");
const outputPath = join(outputDirectory, executableName);
mkdirSync(outputDirectory, { recursive: true });

// Direct spawn works when a real bun.exe is on the PATH (official installer).
// When bun came from npm, the PATH entry is a shell-script shim
// (`bun.cmd`/`bun.sh`) that Node cannot spawn without a shell, so retry
// through one.
function runBun(args: string[]) {
  const command = process.platform === "win32" ? "bun.exe" : "bun";
  const direct = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (direct.error?.code === "ENOENT" && process.platform === "win32") {
    return spawnSync("bun", args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
    });
  }
  return direct;
}

const build = runBun([
  "build",
  "src/cli.ts",
  "--compile",
  "--outfile",
  outputPath,
]);

if (build.error?.code === "ENOENT") {
  throw new Error(
    "Bun is required to build the standalone binary. Install Bun or use the npm-linked CLI.",
  );
}

if (build.status !== 0) {
  process.exitCode = build.status ?? 1;
} else {
  if (process.platform !== "win32") chmodSync(outputPath, 0o755);
  copyFileSync(resolve("package.json"), join(outputDirectory, "package.json"));
  copyFileSync(resolve("README.md"), join(outputDirectory, "README.md"));
  // No CHANGELOG.md ships with the binary. Pi resolves the changelog next to
  // the package.json it reads, so pairing Pi's release notes with RSIH's
  // version makes every Pi release look unseen and replays "What's New" on
  // every start; a missing file reads as no entries, which is what we want.
  // Built-in Genomes. `resolveHarnessGenome` looks for `<PI_PACKAGE_DIR>/genomes`
  // after the project and user directories, so `--genome paperlab` and
  // `--genome harness-rsi` work from any cwd without an install step.
  // Clear the target first so a Genome removed from config/genomes does not
  // keep shipping from earlier builds.
  rmSync(join(outputDirectory, "genomes"), { recursive: true, force: true });
  cpSync(resolve("config", "genomes"), join(outputDirectory, "genomes"), {
    recursive: true,
  });
  cpSync(
    resolve(
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "docs",
    ),
    join(outputDirectory, "docs"),
    { recursive: true },
  );
  cpSync(
    resolve(
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "examples",
    ),
    join(outputDirectory, "examples"),
    { recursive: true },
  );
  cpSync(
    resolve(
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "modes",
      "interactive",
      "theme",
    ),
    join(outputDirectory, "theme"),
    { recursive: true },
  );
  cpSync(
    resolve(
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "modes",
      "interactive",
      "assets",
    ),
    join(outputDirectory, "assets"),
    { recursive: true },
  );
  cpSync(
    resolve(
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "export-html",
    ),
    join(outputDirectory, "export-html"),
    { recursive: true },
  );
  console.log(`Built ${outputPath}`);

  if (process.argv.includes("--install")) install(outputPath);
}

/**
 * Install the built binary together with everything it resolves relative to
 * itself.
 *
 * The binary is not self-sufficient: `PI_PACKAGE_DIR` is the directory the
 * executable sits in, and that is where it looks for package.json (the version),
 * the built-in Genome seeds, themes and Pi's own assets. Copying just the
 * executable onto the PATH produces an rsih that reports version 0.0.0 and
 * cannot find `paperlab` or `harness-rsi` at all. So the whole payload goes to a
 * library directory and only a link goes on the PATH.
 */
function install(outputPath) {
  const binDirectory = resolve(
    process.env.RSIH_INSTALL_DIR ?? join(homedir(), ".local", "bin"),
  );
  const libDirectory = resolve(
    process.env.RSIH_LIB_DIR ?? join(homedir(), ".local", "lib", "rsih"),
  );
  const executable = basename(outputPath);

  mkdirSync(libDirectory, { recursive: true });
  cpSync(dirname(outputPath), libDirectory, { recursive: true, force: true });
  const target = join(libDirectory, executable);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  console.log(`Installed payload to ${libDirectory}`);

  if (process.platform === "win32") {
    // Symlinks need elevation on Windows, so the payload directory itself goes
    // on the PATH.
    console.log(`Add ${libDirectory} to your PATH.`);
    return;
  }

  mkdirSync(binDirectory, { recursive: true });
  const link = join(binDirectory, executable);
  rmSync(link, { force: true });
  symlinkSync(target, link);
  console.log(`Linked ${link}`);

  // `gee` is `rsih --genome harness-rsi`. It cannot be a link, because the
  // binary would have no way to know which name invoked it.
  const gee = join(binDirectory, "gee");
  rmSync(gee, { force: true });
  writeFileSync(
    gee,
    `#!/bin/sh\n# Generated by rsih. Equivalent to: rsih --genome harness-rsi\nexec ${JSON.stringify(link)} --genome harness-rsi "$@"\n`,
    "utf8",
  );
  chmodSync(gee, 0o755);
  console.log(`Wrote ${gee}`);
}
