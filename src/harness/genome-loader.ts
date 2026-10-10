import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createDefaultHarnessGenome } from "./genome.ts";
import { loadHarnessGenomeFile } from "./genome-bundle.ts";

/** Manifest file name inside a directory-shaped Genome bundle. */
export const GENOME_MANIFEST_NAME = "genome.json";

/** Whether a reference is explicitly path-like rather than a bare Genome name. */
export function isPathReference(reference) {
  return (
    isAbsolute(reference) ||
    reference.startsWith(".") ||
    reference.includes("/") ||
    reference.includes("\\") ||
    reference.endsWith(".json")
  );
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a Genome path to the manifest that should be loaded. Directory
 * bundles keep their components, contracts, skills and extensions next to the
 * manifest, which is the only layout `rsih genome install` can copy whole.
 */
export function genomeManifestPath(path) {
  return isDirectory(path) ? join(path, GENOME_MANIFEST_NAME) : path;
}

/** `~/.rsih/genomes` — where every Genome the user actually runs lives. */
export function userGenomeDirectory(homeDirectory = homedir()) {
  return join(resolve(homeDirectory), ".rsih", "genomes");
}

/**
 * Genomes shipped with the distribution, in the two layouts they can appear in:
 * next to a compiled binary, or in the source tree.
 */
export function builtinGenomeDirectories(
  packageDirectory = process.env.PI_PACKAGE_DIR,
) {
  if (!packageDirectory) return [];
  const base = resolve(packageDirectory);
  return [join(base, "genomes"), join(base, "config", "genomes")];
}

/**
 * Directories searched for a Genome referenced by bare name, in priority order:
 * project, user, then the built-in seeds. A user copy always shadows a built-in
 * of the same name.
 */
export function genomeSearchDirectories({
  cwd = process.cwd(),
  homeDirectory = homedir(),
  packageDirectory = process.env.PI_PACKAGE_DIR,
} = {}) {
  return [
    join(resolve(cwd), ".rsih", "genomes"),
    userGenomeDirectory(homeDirectory),
    ...builtinGenomeDirectories(packageDirectory),
  ];
}

/**
 * Genomes in one directory, in the two shapes a bare name can resolve to.
 * `bundle` distinguishes `<name>/genome.json` from `<name>.json`, which is what
 * `genome list` needs to render and what `seedStatus` needs to locate a copy.
 */
export function genomeNamesIn(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  for (const entry of entries) {
    // Replaced bundles are recovery backups, not installable Genomes. Single-file
    // backups do not end in `.json`, but skipping both shapes keeps `list` honest.
    if (/\.replaced(?:\.\d+)?$/.test(entry)) continue;
    const path = join(directory, entry);
    if (entry.endsWith(".json") && !isDirectory(path)) {
      found.push({ name: basename(entry, ".json"), bundle: false });
    } else if (isDirectory(path) && existsSync(join(path, GENOME_MANIFEST_NAME))) {
      found.push({ name: entry, bundle: true });
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Every Genome reachable by bare name, deduplicated the way `resolveHarnessGenome`
 * resolves: the first layer to declare a name is the one that would load, so a
 * user copy hides a built-in of the same name here too.
 */
export function availableGenomeNames(options = {}) {
  const byName = new Map();
  for (const directory of genomeSearchDirectories(options)) {
    for (const { name } of genomeNamesIn(directory)) {
      if (!byName.has(name)) byName.set(name, directory);
    }
  }
  return [...byName.keys()].sort();
}

/** Manifest for a bare Genome name inside one directory: file, then bundle. */
function manifestIn(directory, reference) {
  const candidates = [
    join(directory, `${reference}.json`),
    join(directory, reference, GENOME_MANIFEST_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Locate a Genome among the built-in seeds only. */
export function findBuiltinGenome(reference, { packageDirectory } = {}) {
  for (const directory of builtinGenomeDirectories(packageDirectory)) {
    const manifest = manifestIn(directory, reference);
    if (manifest) return manifest;
  }
  return undefined;
}

/**
 * Records which shipped seed an installed Genome was copied from, so a later
 * RSIH can tell "you are running an older seed" apart from "you edited this".
 */
export const SEED_MARKER_NAME = ".rsih-seed.json";

function hashInto(hash, path, relative) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name === SEED_MARKER_NAME) continue;
      hashInto(hash, join(path, name), relative ? `${relative}/${name}` : name);
    }
    return;
  }
  // Paths go into the digest so a rename counts as a change. The marker is
  // excluded so stamping an install cannot alter its own hash.
  hash.update(`${relative}\0`);
  hash.update(readFileSync(path));
  hash.update("\0");
}

/** Content hash of a Genome bundle directory, or undefined if unreadable. */
export function genomeContentHash(path) {
  try {
    const hash = createHash("sha256");
    hashInto(hash, path, "");
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function readSeedMarker(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, SEED_MARKER_NAME), "utf8"));
  } catch {
    return undefined;
  }
}

/** `genome_id` straight off the manifest, without validating the whole Genome. */
function manifestGenomeId(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")).genome_id;
  } catch {
    return undefined;
  }
}

function nextAvailablePath(path) {
  let candidate = path;
  let suffix = 1;
  while (lstatSync(candidate, { throwIfNoEntry: false })) {
    candidate = `${path}.${suffix++}`;
  }
  return candidate;
}

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Copy a built-in Genome into `~/.rsih/genomes` and return the installed
 * manifest.
 *
 * The distribution directory is a seed, not a runtime location. Copying on
 * first use means every Genome the user runs lives in one predictable place,
 * its skills and extensions are read from there, and the directory can be
 * handed to someone else unchanged.
 */
export function installGenomeBundle(manifestPath, name, homeDirectory = homedir()) {
  const isBundle = basename(manifestPath) === GENOME_MANIFEST_NAME;
  const source = isBundle ? dirname(manifestPath) : manifestPath;
  const directory = userGenomeDirectory(homeDirectory);
  const target = join(directory, isBundle ? name : `${name}.json`);
  if (existsSync(target) && sameRealPath(source, target)) {
    return {
      path: isBundle ? join(target, GENOME_MANIFEST_NAME) : target,
      replaced: undefined,
      replacements: [],
    };
  }
  mkdirSync(directory, { recursive: true });

  if (!isBundle) {
    cpSync(source, target, { recursive: true, force: true });
    return { path: target, replaced: undefined, replacements: [] };
  }

  // Build the new bundle away from the live path. A recursive `cpSync` into an
  // existing directory merges trees, so files removed from the seed survive and
  // poison the next marker comparison.
  const sourceHash = genomeContentHash(source);
  if (!sourceHash) throw new Error(`Cannot hash Genome source: ${source}`);
  const sourceGenomeId = manifestGenomeId(manifestPath);
  const temporary = mkdtempSync(join(directory, `.${name}.tmp-`));
  const targetExists = existsSync(target);
  const targetHash = targetExists ? genomeContentHash(target) : undefined;
  const marker = targetExists ? readSeedMarker(target) : undefined;
  const targetIsUnmodified =
    targetHash === sourceHash ||
    (targetHash !== undefined &&
      marker?.hash === targetHash &&
      marker?.genome_id !== undefined &&
      marker.genome_id === sourceGenomeId);
  const shouldBackupTarget = targetExists && !targetIsUnmodified;

  let temporaryTarget;
  let shadowingBackup;
  let replaced;
  const replacements = [];
  let installed = false;
  try {
    cpSync(source, temporary, { recursive: true, force: true });
    writeFileSync(
      join(temporary, SEED_MARKER_NAME),
      `${JSON.stringify({ name, hash: sourceHash, genome_id: sourceGenomeId, source }, null, 2)}\n`,
      "utf8",
    );

    // `<name>.json` is looked up before `<name>/genome.json`; preserve a legacy
    // single-file copy rather than allowing it to make the bundle install a
    // silent no-op.
    const shadowing = join(directory, `${name}.json`);
    if (existsSync(shadowing)) {
      shadowingBackup = nextAvailablePath(`${shadowing}.replaced`);
      renameSync(shadowing, shadowingBackup);
      replacements.push(shadowingBackup);
    }

    // Move the old bundle aside even when it will be discarded. This makes the
    // final rename recoverable if the filesystem rejects the replacement.
    if (targetExists) {
      temporaryTarget = nextAvailablePath(`${target}.old`);
      renameSync(target, temporaryTarget);
    }
    renameSync(temporary, target);
    installed = true;

    if (temporaryTarget) {
      if (shouldBackupTarget) {
        replaced = nextAvailablePath(`${target}.replaced`);
        renameSync(temporaryTarget, replaced);
        replacements.push(replaced);
      } else {
        rmSync(temporaryTarget, { recursive: true, force: true });
      }
    }
    return {
      path: join(target, GENOME_MANIFEST_NAME),
      replaced: replaced ?? replacements[0],
      replacements,
    };
  } catch (error) {
    // Restore the old paths if the swap failed. Cleanup is best effort so the
    // original error remains the actionable one.
    try {
      if (installed && existsSync(target)) rmSync(target, { recursive: true, force: true });
      if (temporaryTarget && existsSync(temporaryTarget) && !existsSync(target)) {
        renameSync(temporaryTarget, target);
      }
      if (shadowingBackup && existsSync(shadowingBackup) && !existsSync(join(directory, `${name}.json`))) {
        renameSync(shadowingBackup, join(directory, `${name}.json`));
      }
      if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    } catch {
      // Preserve the original failure; the filesystem state is reported by the
      // caller rather than hiding it behind rollback diagnostics.
    }
    throw error;
  }
  return {
    path: isBundle ? join(target, GENOME_MANIFEST_NAME) : target,
    replaced,
  };
}

/** Seed on first use, but never let an unwritable home break startup. */
function seedBuiltinGenome(manifestPath, name, homeDirectory) {
  try {
    return installGenomeBundle(manifestPath, name, homeDirectory).path;
  } catch {
    return manifestPath;
  }
}

/**
 * How an installed copy relates to the seed this RSIH ships.
 *
 * A seed is copied once, so without this check a shipped fix never reaches
 * anyone who already ran the Genome. Re-copying unconditionally is not an option
 * either: the installed copy is the one the user is meant to edit. The marker
 * written at install time is what separates the two cases.
 *
 * `modified` also covers a copy installed before markers existed, because an
 * unmarked directory is indistinguishable from an edited one. Warning is the
 * safe answer there.
 *
 * The `genome_id` check is what keeps a shared Genome safe. A marker travels
 * inside the bundle, so a Genome someone hands you arrives carrying their
 * marker; if it happens to share a name with a built-in, the hashes alone would
 * read as "an untouched older seed" and it would be silently replaced. Requiring
 * the ids to match means a different Genome is only ever reported, never copied
 * over.
 */
export function seedStatus(installedManifest, builtinManifest) {
  if (basename(builtinManifest) !== GENOME_MANIFEST_NAME) {
    // A single-file seed has nowhere to keep a marker.
    return "unknown";
  }
  if (basename(installedManifest) !== GENOME_MANIFEST_NAME) {
    // A single-file copy left over from before bundles existed. It wins the
    // lookup forever, so it has to be called out by name.
    return "shadowed";
  }
  const installed = dirname(installedManifest);
  const shippedHash = genomeContentHash(dirname(builtinManifest));
  if (!shippedHash) return "unknown";

  const marker = readSeedMarker(installed);
  // The seed has not moved since this copy was installed, so there is nothing
  // newer to report -- including when the user has since edited their copy,
  // which is what the copy is for.
  if (marker?.hash === shippedHash) return "current";

  const installedHash = genomeContentHash(installed);
  if (!installedHash) return "unknown";
  // An unmarked copy that already matches needs no warning.
  if (installedHash === shippedHash) return "current";

  const sameGenome =
    manifestGenomeId(installedManifest) !== undefined &&
    manifestGenomeId(installedManifest) === manifestGenomeId(builtinManifest);
  if (marker && sameGenome && installedHash === marker.hash) return "stale";
  return "modified";
}

export function resolveHarnessGenome(
  reference,
  {
    cwd = process.cwd(),
    homeDirectory = homedir(),
    packageDirectory,
    seedBuiltins = true,
  } = {},
) {
  if (!reference || reference === "default") {
    return {
      genome: createDefaultHarnessGenome(),
      reference: "default",
      path: undefined,
      baseDirectory: resolve(cwd),
    };
  }

  if (isPathReference(reference)) {
    const directPath = resolve(cwd, reference);
    if (existsSync(directPath)) {
      const manifest = genomeManifestPath(directPath);
      if (!existsSync(manifest)) {
        throw new Error(
          `Harness Genome directory has no ${GENOME_MANIFEST_NAME}: ${directPath}`,
        );
      }
      return loaded(manifest, reference);
    }
    throw new Error(`Harness Genome does not exist: ${directPath}`);
  }

  const options = { cwd, homeDirectory, packageDirectory };
  const userDirectory = userGenomeDirectory(homeDirectory);
  for (const directory of [join(resolve(cwd), ".rsih", "genomes"), userDirectory]) {
    const manifest = manifestIn(directory, reference);
    if (!manifest) continue;
    // Only the user layer is a seed target, so only it can go stale.
    if (directory !== userDirectory) return loaded(manifest, reference);
    const builtin = findBuiltinGenome(reference, options);
    if (!builtin) return loaded(manifest, reference);
    const status = seedStatus(manifest, builtin);
    if (status === "stale" && seedBuiltins) {
      const refreshed = seedBuiltinGenome(builtin, reference, homeDirectory);
      return loaded(refreshed, reference, { refreshed: refreshed !== builtin });
    }
    const outdated = status === "modified" || status === "shadowed";
    try {
      return loaded(manifest, reference, { outdated });
    } catch (error) {
      // A broken copy in the user layer hides a working shipped one, and the
      // bare load error gives no hint of that.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `This came from your own copy at ${manifest}, which shadows the ${reference} shipped with this RSIH. ` +
          `Run "rsih genome install ${reference}" to replace it.`,
      );
    }
  }

  const builtin = findBuiltinGenome(reference, options);
  if (builtin) {
    const manifest = seedBuiltins
      ? seedBuiltinGenome(builtin, reference, homeDirectory)
      : builtin;
    return loaded(manifest, reference, { seeded: manifest !== builtin });
  }

  throw new Error(
    `Harness Genome "${reference}" was not found in ${genomeSearchDirectories(options).join(" or ")}.`,
  );
}

function loaded(manifestPath, reference, flags = {}) {
  const result = loadHarnessGenomeFile(manifestPath);
  return {
    genome: result.genome,
    reference,
    path: manifestPath,
    baseDirectory: result.baseDirectory,
    components: result.components,
    seeded: flags.seeded ?? false,
    refreshed: flags.refreshed ?? false,
    outdated: flags.outdated ?? false,
  };
}

export function genomeDisplayName(resolvedGenome) {
  if (resolvedGenome.reference === "default") return "default";
  if (resolvedGenome.path) {
    // A directory bundle's manifest is always `genome.json`, so the bundle
    // directory carries the name the user typed.
    const name =
      basename(resolvedGenome.path) === GENOME_MANIFEST_NAME
        ? basename(dirname(resolvedGenome.path))
        : basename(resolvedGenome.path, ".json");
    if (!resolvedGenome.reference.includes(sep)) return name;
  }
  return resolvedGenome.reference;
}

/**
 * The name a Genome is installed under, derived from its own layout rather
 * than from how it was referenced. A path reference must not become the
 * directory name: installing `examples/genomes/paperlab` used to create
 * `~/.rsih/genomes/examples/genomes/paperlab/`, which `genome list` cannot
 * see and no bare name can launch.
 */
export function genomeInstallName(resolvedGenome) {
  if (!resolvedGenome.path) return resolvedGenome.reference;
  return basename(resolvedGenome.path) === GENOME_MANIFEST_NAME
    ? basename(dirname(resolvedGenome.path))
    : basename(resolvedGenome.path, ".json");
}
