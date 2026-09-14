import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createDefaultHarnessGenome } from "./genome.ts";
import { loadHarnessGenomeFile } from "./genome-bundle.ts";

/** Manifest file name inside a directory-shaped Genome bundle. */
export const GENOME_MANIFEST_NAME = "genome.json";

function isPathReference(reference) {
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
  mkdirSync(directory, { recursive: true });

  // `<name>.json` is looked up before `<name>/genome.json`, so installing a
  // bundle while a single-file copy of the same name sits next to it would have
  // no effect at all. Move the file aside rather than leave the install a no-op
  // or delete something the user may have written.
  let replaced;
  const shadowing = join(directory, `${name}.json`);
  if (isBundle && existsSync(shadowing)) {
    replaced = `${shadowing}.replaced`;
    let suffix = 1;
    while (lstatSync(replaced, { throwIfNoEntry: false })) {
      replaced = `${shadowing}.replaced.${suffix++}`;
    }
    renameSync(shadowing, replaced);
  }

  cpSync(source, target, { recursive: true, force: true });
  if (isBundle) {
    const hash = genomeContentHash(source);
    if (hash) {
      writeFileSync(
        join(target, SEED_MARKER_NAME),
        `${JSON.stringify({ name, hash, genome_id: manifestGenomeId(manifestPath), source }, null, 2)}\n`,
        "utf8",
      );
    }
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

  if (isPathReference(reference)) {
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
