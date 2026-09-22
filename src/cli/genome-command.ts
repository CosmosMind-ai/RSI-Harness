import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir as getPiAgentDir } from "@earendil-works/pi-coding-agent";
import {
  GENOME_MANIFEST_NAME,
  builtinGenomeDirectories,
  findBuiltinGenome,
  genomeDisplayName,
  genomeInstallName,
  genomeNamesIn,
  genomeSearchDirectories,
  installGenomeBundle,
  resolveHarnessGenome,
  seedStatus,
  userGenomeDirectory,
} from "../harness/genome-loader.ts";
import { projectGenomeSettings } from "../harness/pi-projection.ts";
import { mergeManagedSettings } from "../harness/settings-layer.ts";

const USAGE = `Usage: rsih genome <command>

  list                    List Genomes found in ./.rsih/genomes, ~/.rsih/genomes and the built-in seeds
  show <name|path>        Print the resolved Genome and the Pi settings it manages
  validate <name|path>    Load and validate a Genome without starting a session
  install <name|path>     Copy a Genome into ~/.rsih/genomes. A bare name reinstalls the shipped seed.
`;

/** Display names for one directory: bundles are shown with a trailing slash. */
function genomeDisplayNamesIn(directory) {
  return genomeNamesIn(directory).map(({ name, bundle }) =>
    bundle ? `${name}/` : name,
  );
}

/**
 * How an installed copy compares with the seed this RSIH ships. Without this,
 * a Genome that has fallen behind looks identical to a current one, which is how
 * a shipped fix goes unnoticed.
 */
function seedLabel(directory, name) {
  const bare = name.endsWith("/") ? name.slice(0, -1) : name;
  const builtin = findBuiltinGenome(bare);
  if (!builtin) return "";
  const installed = name.endsWith("/")
    ? join(directory, bare, GENOME_MANIFEST_NAME)
    : join(directory, `${bare}.json`);
  if (!existsSync(installed)) return "";
  switch (seedStatus(installed, builtin)) {
    case "stale":
      return "  (older than the shipped seed; refreshed on next launch)";
    case "modified":
      return `  (differs from the shipped seed; "rsih genome install ${bare}" replaces it)`;
    case "shadowed":
      return `  (single-file copy shadowing the shipped bundle; "rsih genome install ${bare}" replaces it)`;
    default:
      return "";
  }
}

function listGenomes(cwd, io) {
  let found = 0;
  const seen = new Set();
  const builtins = new Set(builtinGenomeDirectories());
  for (const directory of genomeSearchDirectories({ cwd })) {
    // Dedupe by real path: running inside your home directory makes the project
    // and user layers the same place under two spellings.
    let key = directory;
    try {
      key = realpathSync(directory);
    } catch {
      // Missing directory: the string is a good enough key.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const names = genomeDisplayNamesIn(directory);
    if (names.length === 0) continue;
    found += names.length;
    const isSeedLayer = builtins.has(directory);
    // Built-ins are seeds: they get copied into ~/.rsih/genomes on first use.
    io.log(isSeedLayer ? `${directory} (seeds)` : directory);
    for (const name of names) {
      io.log(`  ${name}${isSeedLayer ? "" : seedLabel(directory, name)}`);
    }
  }
  if (found === 0) {
    io.log(
      `No Genomes found. Add one to ${userGenomeDirectory()} or run "rsih genome install <path>".`,
    );
  }
}

// Inspection must not have side effects, so neither command seeds.
function showGenome(reference, cwd, io) {
  const resolved = resolveHarnessGenome(reference, { cwd, seedBuiltins: false });
  const projection = projectGenomeSettings(resolved.genome);
  io.log(`Genome: ${genomeDisplayName(resolved)}`);
  if (resolved.path) io.log(`Source: ${resolved.path}`);
  if (resolved.components?.length) {
    io.log(`Components: ${resolved.components.map((c) => c.id).join(", ")}`);
  }
  io.log("");
  io.log("Resolved Genome:");
  io.log(JSON.stringify(resolved.genome, null, 2));
  io.log("");
  // Show the compiled result, not just the patch: what lands on disk is what
  // the user needs to reason about.
  io.log(`Managed Pi settings (${join(getPiAgentDir(), "settings.json")}):`);
  io.log(JSON.stringify(projection.settings, null, 2));
  io.log("");
  io.log(`Managed keybindings (${join(getPiAgentDir(), "keybindings.json")}):`);
  io.log(JSON.stringify(projection.keybindings, null, 2));
}

function validateGenome(reference, cwd, io) {
  const resolved = resolveHarnessGenome(reference, { cwd, seedBuiltins: false });
  const projection = projectGenomeSettings(resolved.genome);
  mergeManagedSettings({}, projection.settings, {});
  mergeManagedSettings({}, projection.keybindings, {});
  io.log(
    `${genomeDisplayName(resolved)} is valid (${resolved.components?.length ?? 0} components, ${Object.keys(projection.settings).length} managed settings).`,
  );
}

/**
 * Copy a Genome into ~/.rsih/genomes. Bundle directories are copied whole
 * because their components, contracts, skills and extensions are referenced
 * relative to the manifest; a single-file Genome is copied as-is.
 *
 * A bare name always installs the shipped seed, overwriting whatever is there,
 * so this doubles as "reset this Genome to the version I shipped with".
 */
/** Say when installing had to move a shadowing single-file Genome aside. */
function reportReplacedFile(installed, io) {
  if (!installed.replaced) return;
  io.log(
    `Moved the single-file Genome that was shadowing it to ${installed.replaced}`,
  );
}

function installGenome(reference, cwd, io) {
  const builtin = existsSync(resolve(cwd, reference))
    ? undefined
    : findBuiltinGenome(reference);
  if (builtin) {
    const installed = installGenomeBundle(builtin, reference);
    io.log(`Installed ${reference} to ${dirname(installed.path)}`);
    reportReplacedFile(installed, io);
    return;
  }

  const resolved = resolveHarnessGenome(reference, { cwd, seedBuiltins: false });
  if (!resolved.path) {
    throw new Error(`Genome "${reference}" has no source file to install.`);
  }
  // The install name comes from the bundle's own directory, not from the
  // reference: `install examples/genomes/paperlab` must install a Genome
  // named paperlab, not one buried under examples/genomes/.
  const name = genomeInstallName(resolved);
  const installed = installGenomeBundle(resolved.path, name);
  if (resolve(installed.path) === resolve(resolved.path)) {
    io.log(`${name} is already installed at ${installed.path}`);
    return;
  }
  io.log(`Installed ${name} to ${installed.path}`);
  reportReplacedFile(installed, io);
}

/**
 * Handle `rsih genome ...`. Returns false when argv is not a genome command so
 * the caller falls through to Pi.
 */
export function runGenomeCommand(argv, { cwd = process.cwd(), io = console } = {}) {
  if (argv[0] !== "genome") return false;
  const [, command, argument] = argv;

  if (!command || command === "--help" || command === "-h") {
    io.log(USAGE);
    return true;
  }
  if (command === "list") {
    listGenomes(cwd, io);
    return true;
  }
  if (!argument) {
    throw new Error(`rsih genome ${command} requires a Genome name or path.`);
  }
  if (command === "show") {
    showGenome(argument, cwd, io);
    return true;
  }
  if (command === "validate") {
    validateGenome(argument, cwd, io);
    return true;
  }
  if (command === "install") {
    installGenome(argument, cwd, io);
    return true;
  }
  throw new Error(`Unknown genome command "${command}".\n\n${USAGE}`);
}
