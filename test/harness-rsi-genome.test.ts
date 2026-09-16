import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { geeArgs } from "../src/gee/cli.ts";
import { runGenomeCommand } from "../src/cli/genome-command.ts";
import {
  GENOME_MANIFEST_NAME,
  HARNESS_COMPONENT_IDS,
  SEED_MARKER_NAME,
  genomeContentHash,
  genomeDisplayName,
  installGenomeBundle,
  loadHarnessGenomeFile,
  resolveHarnessGenome,
} from "../src/index.ts";
import { genomeSeedNotice } from "../src/pi-cli-runtime.ts";
import { PI_BUILTIN_TOOL_NAMES } from "../src/harness/pi-surface.ts";

const repository = join(import.meta.dirname, "..");
const bundle = join(repository, "config", "genomes", "harness-rsi");
const skill = join(bundle, "skills", "genome-authoring");
const docsContracts = join(repository, "docs", "genome", "components");

const KEY_DOWN = `${String.fromCharCode(27)}[B`;
const KEY_ENTER = String.fromCharCode(13);
const KEY_ESCAPE = String.fromCharCode(27);

/* ------------------------------------------------------- the shipped bundles */

test("shipped bundles carry a byte-identical copy of every contract", () => {
  const expected = readdirSync(docsContracts)
    .filter((name) => name.endsWith(".dev.md"))
    .sort();
  assert.equal(
    expected.length,
    HARNESS_COMPONENT_IDS.length,
    "docs/genome/components must document every component",
  );
  for (const shipped of ["paperlab", "harness-rsi"]) {
    const contracts = join(repository, "config", "genomes", shipped, "contracts");
    assert.deepEqual(readdirSync(contracts).sort(), expected, shipped);
    for (const name of expected) {
      // A bundle has to carry its contracts to be installable, so the only way
      // to keep them honest is to fail when they drift from the dev docs.
      assert.equal(
        readFileSync(join(contracts, name), "utf8"),
        readFileSync(join(docsContracts, name), "utf8"),
        `${shipped}/contracts/${name} drifted from docs/genome/components/${name}`,
      );
    }
  }
});

test("shipped bundles are self-contained and resolve from their own directory", () => {
  for (const shipped of ["paperlab", "harness-rsi"]) {
    const loaded = loadHarnessGenomeFile(
      join(repository, "config", "genomes", shipped, GENOME_MANIFEST_NAME),
    );
    assert.equal(loaded.genome.genome_schema_version, "2");
    // `base: "default"` keeps a bundle portable; a path base would break once
    // the bundle is copied into ~/.rsih/genomes.
    assert.equal(loaded.genome.component_manifest.base, "default");
    for (const component of loaded.components) {
      assert.ok(
        component.contract.startsWith(join(repository, "config", "genomes", shipped)),
        `${shipped}/${component.id} points its contract outside the bundle`,
      );
    }
  }
});

/**
 * paperlab lives in two places on purpose: `config/genomes/paperlab` is the
 * seed that ships with the binary, `examples/genomes/paperlab` is the copy on
 * the community shelf. They must stay byte-identical, or the two would
 * silently become different Genomes that happen to share a name.
 */
function assertSameTree(left, right) {
  const leftEntries = readdirSync(left, { withFileTypes: true }).sort();
  const rightEntries = readdirSync(right, { withFileTypes: true }).sort();
  assert.deepEqual(
    leftEntries.map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`),
    rightEntries.map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`),
    `${basename(left)} and ${basename(right)} list different files`,
  );
  for (const entry of leftEntries) {
    if (entry.isDirectory()) {
      assertSameTree(join(left, entry.name), join(right, entry.name));
    } else {
      assert.equal(
        readFileSync(join(left, entry.name), "utf8"),
        readFileSync(join(right, entry.name), "utf8"),
        `${join(left, entry.name)} differs from its mirror in ${right}`,
      );
    }
  }
}

test("the shipped paperlab seed and the examples copy are byte-identical", () => {
  assertSameTree(
    join(repository, "config", "genomes", "paperlab"),
    join(repository, "examples", "genomes", "paperlab"),
  );
});

test("the harness-rsi skill indexes every component contract", () => {
  const text = readFileSync(join(skill, "SKILL.md"), "utf8");
  for (const id of HARNESS_COMPONENT_IDS) {
    assert.match(text, new RegExp(`contracts/${id}\\.dev\\.md`), id);
  }
  for (const reference of ["merge-semantics.md", "session-forensics.md", "pattern-to-component.md"]) {
    assert.ok(text.includes(reference), `SKILL.md must point at ${reference}`);
    assert.ok(readFileSync(join(skill, reference), "utf8").length > 0);
  }
});

test("the harness-rsi Genome wires its own extension and skill", () => {
  const loaded = loadHarnessGenomeFile(join(bundle, GENOME_MANIFEST_NAME));
  const genome = loaded.genome;
  assert.deepEqual(genome.extensions, ["./extension/harness-rsi.ts"]);
  assert.deepEqual(genome.skills, [
    { source: "./skills/genome-authoring", enabled: true },
  ]);
  // Declared resource paths have to exist relative to the manifest, otherwise
  // Pi fails at load time with a bare ENOENT.
  for (const relative of ["./extension/harness-rsi.ts", "./skills/genome-authoring/SKILL.md"]) {
    assert.ok(
      readFileSync(join(bundle, relative), "utf8").length > 0,
      `${relative} is missing or empty`,
    );
  }
  // Replacing Pi's prompt would discard its tool-use guidance.
  assert.equal(genome.system_prompt, undefined);
  assert.match(genome.append_system_prompt, /Genome author/);
  // Isolation keeps the prescribed workflow out of reach of the user's global
  // skills; without it every unrelated skill on the machine enters the prompt.
  assert.equal(genome.resources.isolate, true);
});

/**
 * The whole Genome is a prescribed workflow, and the prompt is the only place it
 * is written down. These are the steps a user would notice the absence of: the
 * opening question, and the approval gate that stands between the analysis and
 * the files it writes.
 */
test("the prescribed sequence keeps its gates", () => {
  const prompt = loadHarnessGenomeFile(join(bundle, GENOME_MANIFEST_NAME)).genome
    .append_system_prompt as string;
  const steps = [...prompt.matchAll(/^(\d+)\. \*\*/gm)].map((match) => Number(match[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7]);
  assert.match(prompt, /Do not skip or reorder steps 1-7/);
  // Step 1 is a question in the chat. A dialog would narrow an open description
  // down to the options the model happened to think of.
  assert.match(
    prompt,
    /Ask what the Genome is for, in the chat, as plain text\.\*\* Your first turn is that question and nothing else/,
  );
  assert.match(prompt, /specifically not `AskUserQuestion`/);
  // Nothing reaches disk before the user has seen the plan.
  assert.match(prompt, /Write nothing until they answer/);
  // Findings are judged against what the user said they want, not against a
  // generically good harness.
  assert.match(prompt, /## The scenario answer is the yardstick/);
});

/* ---------------------------------------------------------- built-in lookup */

test("a Genome resolves as a directory bundle and by name from the distribution", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-builtin-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-builtin-cwd-"));

  const byPath = resolveHarnessGenome(bundle, { cwd, homeDirectory: home });
  assert.equal(basename(byPath.path), GENOME_MANIFEST_NAME);
  // A path reference keeps displaying as the path the user typed.
  assert.equal(genomeDisplayName(byPath), bundle);
  assert.equal(byPath.seeded, false, "an explicit path must not be copied anywhere");

  const byName = resolveHarnessGenome("harness-rsi", {
    cwd,
    homeDirectory: home,
    packageDirectory: repository,
    seedBuiltins: false,
  });
  assert.equal(dirname(byName.path), bundle);
  // A bare name must not display as the manifest file name.
  assert.equal(genomeDisplayName(byName), "harness-rsi");

  // Nothing to fall back to when the distribution carries no Genomes.
  assert.throws(
    () =>
      resolveHarnessGenome("harness-rsi", {
        cwd,
        homeDirectory: home,
        packageDirectory: mkdtempSync(join(tmpdir(), "rsih-no-builtins-")),
      }),
    /was not found/,
  );
});

test("a built-in Genome is seeded into the user directory on first use", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-seed-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-seed-cwd-"));
  const installed = join(home, ".rsih", "genomes", "harness-rsi");
  assert.ok(!existsSync(installed));

  const first = resolveHarnessGenome("harness-rsi", {
    cwd,
    homeDirectory: home,
    packageDirectory: repository,
  });
  // The distribution directory is a seed, not a runtime location: what the
  // agent runs -- and reads its skills from -- must live under ~/.rsih/genomes.
  assert.equal(first.seeded, true);
  assert.equal(first.path, join(installed, GENOME_MANIFEST_NAME));
  assert.ok(existsSync(join(installed, "skills", "genome-authoring", "SKILL.md")));
  assert.ok(existsSync(join(installed, "extension", "harness-rsi.ts")));
  assert.ok(existsSync(join(installed, "contracts", "tools.dev.md")));

  // Second use loads the installed copy and copies nothing.
  const second = resolveHarnessGenome("harness-rsi", {
    cwd,
    homeDirectory: home,
    packageDirectory: repository,
  });
  assert.equal(second.seeded, false);
  assert.equal(second.path, first.path);
});

/** A minimal shipped seed we can edit, standing in for a distribution. */
function writeShippedSeed(packageDirectory, name, marker) {
  const bundle = join(packageDirectory, "genomes", name);
  mkdirSync(join(bundle, "components"), { recursive: true });
  mkdirSync(join(bundle, "contracts"), { recursive: true });
  writeFileSync(
    join(bundle, GENOME_MANIFEST_NAME),
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: `harness:${name}`,
      base: "default",
      components: [
        {
          id: "instructions",
          contract: "./contracts/instructions.dev.md",
          source: "./components/instructions.json",
        },
      ],
    }),
    "utf8",
  );
  writeFileSync(
    join(bundle, "components", "instructions.json"),
    JSON.stringify({
      component_schema_version: "1",
      component_id: "instructions",
      config: { append_system_prompt: marker },
    }),
    "utf8",
  );
  writeFileSync(join(bundle, "contracts", "instructions.dev.md"), "# instructions\n", "utf8");
  return bundle;
}

test("a shipped seed that moved on refreshes an untouched copy", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-refresh-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-refresh-cwd-"));
  const distribution = mkdtempSync(join(tmpdir(), "rsih-refresh-dist-"));
  const options = { cwd, homeDirectory: home, packageDirectory: distribution };

  writeShippedSeed(distribution, "fixture", "v1");
  const first = resolveHarnessGenome("fixture", options);
  assert.equal(first.seeded, true);
  assert.equal(first.genome.append_system_prompt, "v1");
  // The marker is what later lets us tell "stale" apart from "you edited it".
  const installed = join(home, ".rsih", "genomes", "fixture");
  assert.ok(existsSync(join(installed, SEED_MARKER_NAME)));

  // Unchanged distribution: nothing to announce, nothing to copy.
  const again = resolveHarnessGenome("fixture", options);
  assert.deepEqual(
    { seeded: again.seeded, refreshed: again.refreshed, outdated: again.outdated },
    { seeded: false, refreshed: false, outdated: false },
  );

  // A shipped fix has to reach a user who already ran the Genome once --
  // otherwise every improvement is invisible after the first launch.
  writeShippedSeed(distribution, "fixture", "v2");
  const refreshed = resolveHarnessGenome("fixture", options);
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.seeded, false);
  assert.equal(refreshed.genome.append_system_prompt, "v2");
});

test("a copy the user edited is reported, never overwritten", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-edited-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-edited-cwd-"));
  const distribution = mkdtempSync(join(tmpdir(), "rsih-edited-dist-"));
  const options = { cwd, homeDirectory: home, packageDirectory: distribution };

  writeShippedSeed(distribution, "fixture", "v1");
  resolveHarnessGenome("fixture", options);

  const component = join(
    home,
    ".rsih",
    "genomes",
    "fixture",
    "components",
    "instructions.json",
  );
  writeFileSync(
    component,
    JSON.stringify({
      component_schema_version: "1",
      component_id: "instructions",
      config: { append_system_prompt: "mine" },
    }),
    "utf8",
  );
  writeShippedSeed(distribution, "fixture", "v2");

  const resolved = resolveHarnessGenome("fixture", options);
  // The installed copy is the one the user is meant to edit, so a newer seed
  // gets announced and nothing else.
  assert.equal(resolved.outdated, true);
  assert.equal(resolved.refreshed, false);
  assert.equal(resolved.genome.append_system_prompt, "mine");

  // Installing is the explicit way to take the shipped version instead.
  installGenomeBundle(join(distribution, "genomes", "fixture", GENOME_MANIFEST_NAME), "fixture", home);
  const reinstalled = resolveHarnessGenome("fixture", options);
  assert.equal(reinstalled.outdated, false);
  assert.equal(reinstalled.genome.append_system_prompt, "v2");
});

test("an unmarked copy that already matches the seed raises no warning", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-unmarked-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-unmarked-cwd-"));
  const distribution = mkdtempSync(join(tmpdir(), "rsih-unmarked-dist-"));
  const options = { cwd, homeDirectory: home, packageDirectory: distribution };

  const shipped = writeShippedSeed(distribution, "fixture", "v1");
  resolveHarnessGenome("fixture", options);
  const installed = join(home, ".rsih", "genomes", "fixture");
  // Copies installed before markers existed are unmarked but identical, and
  // must not be nagged about.
  rmSync(join(installed, SEED_MARKER_NAME));
  assert.equal(genomeContentHash(installed), genomeContentHash(shipped));

  const resolved = resolveHarnessGenome("fixture", options);
  assert.equal(resolved.outdated, false);
  assert.equal(resolved.refreshed, false);
});

test("a shared Genome that shadows a built-in is never overwritten", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-shared-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-shared-cwd-"));
  const distribution = mkdtempSync(join(tmpdir(), "rsih-shared-dist-"));
  const options = { cwd, homeDirectory: home, packageDirectory: distribution };

  writeShippedSeed(distribution, "fixture", "shipped");

  // Someone hands you their Genome folder. It carries their seed marker, and it
  // happens to share a name with a built-in. Hashes alone would read that as an
  // untouched older seed and replace it.
  const theirs = mkdtempSync(join(tmpdir(), "rsih-shared-src-"));
  const theirBundle = writeShippedSeed(theirs, "fixture", "theirs");
  writeFileSync(
    join(theirBundle, GENOME_MANIFEST_NAME),
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: "harness:someone-elses",
      base: "default",
      components: [
        {
          id: "instructions",
          contract: "./contracts/instructions.dev.md",
          source: "./components/instructions.json",
        },
      ],
    }),
    "utf8",
  );
  installGenomeBundle(join(theirBundle, GENOME_MANIFEST_NAME), "fixture", home);

  const resolved = resolveHarnessGenome("fixture", options);
  assert.equal(resolved.refreshed, false, "a different Genome must never be replaced");
  assert.equal(resolved.outdated, true);
  assert.equal(resolved.genome.append_system_prompt, "theirs");
});

test("installing over a shadowing single-file copy is not a silent no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-shadow-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-shadow-cwd-"));
  const distribution = mkdtempSync(join(tmpdir(), "rsih-shadow-dist-"));
  const options = { cwd, homeDirectory: home, packageDirectory: distribution };

  const shipped = writeShippedSeed(distribution, "fixture", "shipped");
  // A single-file Genome left over from before bundles existed. `<name>.json` is
  // looked up before `<name>/genome.json`, so it wins the lookup forever.
  const genomes = join(home, ".rsih", "genomes");
  mkdirSync(genomes, { recursive: true });
  const single = join(genomes, "fixture.json");
  writeFileSync(
    single,
    JSON.stringify({
      genome_schema_version: "2",
      genome_id: "harness:fixture",
      append_system_prompt: "legacy",
    }),
    "utf8",
  );

  const before = resolveHarnessGenome("fixture", options);
  assert.equal(before.genome.append_system_prompt, "legacy");
  assert.equal(before.outdated, true, "a shadowing single-file copy must be reported");

  const installed = installGenomeBundle(join(shipped, GENOME_MANIFEST_NAME), "fixture", home);
  // Moved aside rather than deleted: the user may have written it.
  assert.equal(installed.replaced, `${single}.replaced`);
  assert.ok(existsSync(installed.replaced));
  assert.ok(!existsSync(single));

  const after = resolveHarnessGenome("fixture", options);
  assert.equal(after.genome.append_system_prompt, "shipped");
  assert.equal(after.outdated, false);
});

test("repeated installs preserve every shadowing single-file backup", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rsih-backup-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const shipped = writeShippedSeed(root, "fixture", "shipped");
  const genomes = join(home, ".rsih", "genomes");
  mkdirSync(genomes, { recursive: true });
  const single = join(genomes, "fixture.json");
  const backups = [];

  for (const prompt of ["first", "second", "third"]) {
    const contents = JSON.stringify({
      genome_schema_version: "2",
      genome_id: "harness:fixture",
      append_system_prompt: prompt,
    });
    writeFileSync(single, contents, "utf8");
    const installed = installGenomeBundle(join(shipped, GENOME_MANIFEST_NAME), "fixture", home);
    backups.push({ path: installed.replaced, contents });
    assert.ok(!existsSync(single));
    for (const backup of backups) {
      assert.equal(readFileSync(backup.path, "utf8"), backup.contents);
    }
  }

  assert.equal(backups[0].path, `${single}.replaced`);
  assert.equal(new Set(backups.map((backup) => backup.path)).size, 3);
  assert.equal(resolveHarnessGenome("fixture", {
    cwd: root,
    homeDirectory: home,
    packageDirectory: root,
  }).genome.append_system_prompt, "shipped");
});

test("the startup notice matches what the loader actually did", () => {
  assert.equal(genomeSeedNotice({ seeded: false, refreshed: false, outdated: false }, "x"), undefined);
  assert.match(
    genomeSeedNotice({ seeded: true, path: join("/tmp", "g", "genome.json") }, "x").message,
    /^Installed Genome "x" to /,
  );
  assert.equal(genomeSeedNotice({ refreshed: true }, "x").level, "info");
  const stale = genomeSeedNotice({ outdated: true }, "x");
  // A warning the user cannot act on is noise, so it names the command.
  assert.equal(stale.level, "warning");
  assert.match(stale.message, /rsih genome install x/);
});

test("the seeded copy is self-contained: no path escapes its own directory", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-selfcontained-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-selfcontained-cwd-"));
  const resolved = resolveHarnessGenome("harness-rsi", {
    cwd,
    homeDirectory: home,
    packageDirectory: repository,
  });
  const root = dirname(resolved.path);

  for (const component of resolved.components) {
    for (const path of [component.contract, component.source].filter(Boolean)) {
      assert.ok(
        path.startsWith(root),
        `${component.id} reaches outside the bundle: ${path}`,
      );
    }
  }
  // Declared runtime resources are relative, so they resolve inside the bundle
  // wherever it is moved to.
  for (const declared of [
    ...resolved.genome.extensions,
    ...resolved.genome.skills.map((skill) => skill.source),
  ]) {
    assert.match(declared, /^\.\//, `${declared} must be bundle-relative`);
    assert.ok(existsSync(join(root, declared)), `${declared} is missing from the copy`);
  }
});

test("a user Genome shadows the built-in of the same name", () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-shadow-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-shadow-cwd-"));
  const genomes = join(home, ".rsih", "genomes");
  mkdirSync(genomes, { recursive: true });
  writeFileSync(
    join(genomes, "harness-rsi.json"),
    JSON.stringify({
      genome_schema_version: "2",
      genome_id: "harness:user-copy",
      parent_id: null,
      version: 1,
    }),
    "utf8",
  );
  const resolved = resolveHarnessGenome("harness-rsi", {
    cwd,
    homeDirectory: home,
    packageDirectory: repository,
  });
  assert.equal(resolved.genome.genome_id, "harness:user-copy");
  assert.equal(resolved.seeded, false, "seeding must never overwrite a user copy");
});

/* ------------------------------------------------------------ genome command */

/** Drive `rsih genome ...` with a captured io, from a scratch cwd. */
function runGenome(args, cwd) {
  const lines = [];
  runGenomeCommand(["genome", ...args], {
    cwd,
    io: { log: (line) => lines.push(String(line)) },
  });
  return lines.join("\n");
}

test("genome list names every discovery layer and marks the seeds", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rsih-list-"));
  const output = runGenome(["list"], cwd);
  // Regression: listGenomes used builtinGenomeDirectories without importing it,
  // which the other tests missed because they never call the command.
  assert.match(output, /harness-rsi\//);
  assert.match(output, /paperlab\//);
  assert.match(output, /\(seeds\)/, "the distribution layer must be labelled");
});

test("genome validate and show accept a bare built-in name without seeding", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rsih-validate-"));
  assert.match(runGenome(["validate", "harness-rsi"], cwd), /harness-rsi is valid/);
  assert.match(runGenome(["show", "harness-rsi"], cwd), /Components: instructions/);
  // Inspection must not write to the user's home directory.
  assert.ok(!existsSync(join(cwd, ".rsih", "genomes")));
});

test("installing from a path lands under the bundle's own name", async () => {
  const home = mkdtempSync(join(tmpdir(), "rsih-install-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "rsih-install-cwd-"));
  // The community shelf layout: a Genome nested more than one directory deep.
  const shared = join(cwd, "examples", "genomes", "paperlab");
  cpSync(bundle, shared, { recursive: true });

  await withHome(home, () => {
    assert.match(
      runGenome(["install", "examples/genomes/paperlab"], cwd),
      /Installed paperlab to .*[/\\]genomes[/\\]paperlab[/\\]genome\.json$/,
    );
  });

  // Regression: the reference string used to become the install name, burying
  // the Genome at ~/.rsih/genomes/examples/genomes/paperlab/ where `genome
  // list` cannot see it and no bare name can launch it.
  assert.ok(
    existsSync(join(home, ".rsih", "genomes", "paperlab", GENOME_MANIFEST_NAME)),
    "the Genome must land under ~/.rsih/genomes/paperlab",
  );
  assert.ok(
    !existsSync(join(home, ".rsih", "genomes", "examples")),
    "the reference path must not become a directory name",
  );
});

for (const layout of ["bundle", "file"]) {
  test(`installing an already-installed ${layout} is a no-op`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "rsih-self-install-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const source = writeShippedSeed(root, "fixture", "original");
    const manifest = layout === "bundle"
      ? join(source, GENOME_MANIFEST_NAME)
      : join(root, "fixture.json");
    if (layout === "file") {
      writeFileSync(manifest, JSON.stringify({
        genome_schema_version: "2",
        genome_id: "harness:fixture",
      }));
    }
    const installed = installGenomeBundle(manifest, "fixture", home);
    if (layout === "bundle") {
      writeFileSync(join(home, ".rsih", "genomes", "fixture.json"), "preserve sibling");
    }
    const marker = layout === "bundle"
      ? readFileSync(join(dirname(installed.path), SEED_MARKER_NAME), "utf8")
      : undefined;
    const before = genomeContentHash(home);

    assert.deepEqual(installGenomeBundle(installed.path, "fixture", home), installed);
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", join(repository, "src", "cli.ts"),
      "genome", "install", installed.path,
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        RSIH_CODING_AGENT_DIR: join(home, ".rsih"),
        PI_CODING_AGENT_DIR: join(home, ".rsih"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture is already installed at/);
    assert.equal(genomeContentHash(home), before);
    if (layout === "bundle") {
      assert.equal(readFileSync(join(dirname(installed.path), SEED_MARKER_NAME), "utf8"), marker);
    }
  });
}

/* -------------------------------------------------------------- gee alias */
test("gee is rsih --genome harness-rsi", () => {
  assert.deepEqual(geeArgs([]), ["--genome", "harness-rsi"]);
  assert.deepEqual(geeArgs(["harness-rsi"]), ["--genome", "harness-rsi"]);
  assert.deepEqual(geeArgs(["harness-rsi", "-p", "go"]), [
    "--genome",
    "harness-rsi",
    "-p",
    "go",
  ]);
  // An explicit Genome wins, so gee stays usable as a plain rsih alias.
  assert.deepEqual(geeArgs(["--genome", "coding"]), ["--genome", "coding"]);
  assert.deepEqual(geeArgs(["--genome=coding"]), ["--genome=coding"]);
  // The shorthand is expanded before the check, so it counts as explicit too.
  assert.deepEqual(geeArgs(["+coding"]), ["--genome", "coding"]);
  assert.deepEqual(geeArgs(["harness-rsi", ":coding"]), ["--genome", "coding"]);
  assert.throws(() => geeArgs(["--spec", "run.json"]), /no longer takes --spec/);
});

/* ------------------------------------------------------- the extension tools */

function fakePi() {
  const pi = {
    tools: new Map(),
    commands: new Map(),
    handlers: new Map(),
    sent: [],
    registerTool: (tool) => pi.tools.set(tool.name, tool),
    registerCommand: (name, command) => pi.commands.set(name, command),
    on: (event, handler) => pi.handlers.set(event, handler),
    sendMessage: (message, options) => pi.sent.push({ kind: "custom", message, options }),
    sendUserMessage: (content, options) => pi.sent.push({ kind: "user", content, options }),
  };
  return pi;
}

async function loadExtension() {
  // On Windows a bare absolute path is not a valid ESM URL; import() needs
  // the file:// form (pathToFileURL) there.
  const module = await import(
    pathToFileURL(join(bundle, "extension", "harness-rsi.ts")).href
  );
  const pi = fakePi();
  module.default(pi);
  return pi;
}

/** A sessions root shaped the way Pi writes one. */
function writeSessionsRoot(cwd, messages) {
  const root = mkdtempSync(join(tmpdir(), "rsih-sessions-"));
  const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const directory = join(root, encoded);
  mkdirSync(directory, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "01a00000-0000-7000-8000-000000000000",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd,
    }),
    ...messages.map((text, index) =>
      JSON.stringify({
        type: "message",
        id: `m${index}`,
        parentId: index === 0 ? null : `m${index - 1}`,
        timestamp: "2026-08-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    ),
  ];
  writeFileSync(join(directory, "session.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return root;
}

test("scan_workspaces reports facts and never leaks transcript text", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  assert.ok(tool, "scan_workspaces must be registered");

  const root = writeSessionsRoot("/Users/x/decks", [
    "help me build a slide deck",
    "secret-token-do-not-copy",
  ]);
  const result = await tool.execute("t1", {
    // Explicitly no built-in sources, so the test never reads the real home.
    sources: [],
    keywords: ["deck"],
    roots: [root],
    limit: 5,
  });

  assert.equal(result.details.workspaces_found, 1);
  const workspace = result.details.workspaces[0];
  assert.equal(workspace.path, "/Users/x/decks");
  assert.equal(workspace.prompts_sampled, 2);
  assert.deepEqual(workspace.matched_keywords, ["deck"]);
  assert.ok(workspace.keyword_score > 0);
  assert.equal(workspace.first_messages[0], "[custom] help me build a slide deck");
  // Prompt text is used for matching but must not reach the model.
  const text = result.content[0].text;
  assert.ok(!text.includes("secret-token-do-not-copy"), "transcript text leaked");
  assert.ok(!("promptText" in workspace) && !("bodyText" in workspace));
  // Ranking is the agent's job, and the tool has to say so.
  assert.match(result.details.ranking, /Rank these yourself/);
});

test("scan_workspaces reports omissions instead of truncating silently", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  const roots = [
    writeSessionsRoot("/Users/x/one", ["one"]),
    writeSessionsRoot("/Users/x/two", ["two"]),
    writeSessionsRoot("/Users/x/three", ["three"]),
  ];
  const result = await tool.execute("t1", { sources: [], roots, limit: 1 });
  assert.equal(result.details.workspaces_found, 3);
  assert.equal(result.details.workspaces_returned, 1);
  assert.equal(result.details.workspaces_omitted, 2);
});

test("scan_workspaces says so when there is no history", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  const result = await tool.execute("t1", {
    sources: [],
    roots: [mkdtempSync(join(tmpdir(), "rsih-empty-"))],
  });
  assert.equal(result.details.workspaces_found, 0);
  assert.match(result.content[0].text, /No session history found/);
});

/* ------------------------------------------------- the Pi session store */

/**
 * RSIH is new, so most people have no history in its own store on the day they
 * first run this Genome. Pi's store uses the same schema at a different root,
 * and reading it is what makes the Genome usable on day one.
 */
function writePiHome() {
  const home = mkdtempSync(join(tmpdir(), "rsih-pi-home-"));
  const directory = join(home, ".pi", "agent", "sessions", "--Users-x-decks--");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "s.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        timestamp: "2026-07-01T00:00:00.000Z",
        cwd: "/Users/x/decks",
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "pi deck request" }] },
      }),
      // A tool result must not be mistaken for something the user typed.
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "toolResult", output: "ignored" }] },
      }),
    ].join("\n"),
    "utf8",
  );
  return home;
}

async function withHome(home, run) {
  // On Windows os.homedir() reads USERPROFILE, not HOME, so both must point at
  // the fake home or the session stores resolve into the real user directory.
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    RSIH_CODING_AGENT_DIR: process.env.RSIH_CODING_AGENT_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Both spellings, because the agent-dir variable is named after the app name
  // resolved from whichever package.json is on PI_PACKAGE_DIR.
  process.env.RSIH_CODING_AGENT_DIR = join(home, ".rsih");
  process.env.PI_CODING_AGENT_DIR = join(home, ".rsih");
  process.env.CODEX_HOME = join(home, ".codex");
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("scan_workspaces reads Pi's own session store", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  const home = writePiHome();

  const result = await withHome(home, () =>
    tool.execute("t1", { sources: ["rsih", "pi"], keywords: ["deck"] }),
  );

  assert.equal(result.details.workspaces_found, 1);
  const [workspace] = result.details.workspaces;
  assert.equal(workspace.path, "/Users/x/decks");
  assert.deepEqual(workspace.sources, [{ id: "pi", sessions: 1, bytes: workspace.bytes }]);
  assert.ok(workspace.keyword_score > 0);
  assert.deepEqual(workspace.first_messages, ["[pi] pi deck request"]);
  // Only genuine user text counts as a prompt.
  assert.equal(workspace.prompts_sampled, 1);

  // Both requested stores are accounted for by id, present or not.
  assert.deepEqual(
    result.details.sources_scanned.map((source) => ({
      id: source.id,
      available: source.available,
      sessions: source.sessions,
    })),
    [
      { id: "rsih", available: false, sessions: 0 },
      { id: "pi", available: true, sessions: 1 },
    ],
  );
});

/**
 * Claude Code's store is the other one people actually arrive with. Its schema
 * differs from Pi's: no header line, cwd on every entry, and `user` entries that
 * are not the user talking.
 */
function writeClaudeHome() {
  const home = mkdtempSync(join(tmpdir(), "rsih-claude-home-"));
  const directory = join(home, ".claude", "projects", "-Users-x-decks");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "e390220b-2f2d-4dfe-982f-e0a9546f4ff9.jsonl"),
    [
      // Leading entries carry no cwd at all.
      JSON.stringify({ type: "mode", mode: "default", sessionId: "s" }),
      JSON.stringify({
        type: "user",
        cwd: "/Users/x/decks",
        promptSource: "typed",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { role: "user", content: "claude deck request" },
      }),
      // A tool result: `user` by role, not by author.
      JSON.stringify({
        type: "user",
        cwd: "/Users/x/decks",
        message: { role: "user", content: [{ type: "tool_result", content: "ignored" }] },
      }),
      // A slash-command echo, which older versions write without promptSource.
      JSON.stringify({
        type: "user",
        cwd: "/Users/x/decks",
        isMeta: true,
        message: { role: "user", content: "<command-name>/model</command-name>" },
      }),
      JSON.stringify({
        type: "user",
        cwd: "/Users/x/decks",
        message: { role: "user", content: "<local-command-stdout>also ignored" },
      }),
    ].join("\n"),
    "utf8",
  );
  return home;
}

test("scan_workspaces reads Claude Code's session store", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  const home = writeClaudeHome();

  const result = await withHome(home, () =>
    tool.execute("t1", { sources: ["claude"], keywords: ["deck"] }),
  );

  assert.equal(result.details.workspaces_found, 1);
  const [workspace] = result.details.workspaces;
  // The encoded directory name is lossy, so the cwd comes off the entries.
  assert.equal(workspace.path, "/Users/x/decks");
  assert.deepEqual(workspace.sources, [
    { id: "claude", sessions: 1, bytes: workspace.bytes },
  ]);
  assert.deepEqual(workspace.first_messages, ["[claude] claude deck request"]);
  // Tool results, meta entries and command output are not things the user said.
  assert.equal(workspace.prompts_sampled, 1);
});

test("scan_workspaces merges one workspace across Pi and Claude", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  // Both fixtures use the same cwd under different roots inside one home.
  const home = writePiHome();
  const claude = join(home, ".claude", "projects", "-Users-x-decks");
  mkdirSync(claude, { recursive: true });
  cpSync(
    join(writeClaudeHome(), ".claude", "projects", "-Users-x-decks"),
    claude,
    { recursive: true },
  );

  const result = await withHome(home, () =>
    tool.execute("t1", { sources: ["pi", "claude"] }),
  );

  assert.equal(result.details.workspaces_found, 1);
  const [workspace] = result.details.workspaces;
  assert.deepEqual(
    workspace.sources.map((source) => source.id).sort(),
    ["claude", "pi"],
  );
  assert.equal(workspace.sessions, 2);
});

test("scan_workspaces names sources it cannot read instead of returning less", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  const home = mkdtempSync(join(tmpdir(), "rsih-bare-home-"));

  const result = await withHome(home, () =>
    tool.execute("t1", { sources: ["pi", "nonesuch"] }),
  );

  assert.deepEqual(result.details.unknown_sources, ["nonesuch"]);
  assert.ok(result.details.sources_scanned.every((source) => !source.available));
  assert.match(result.content[0].text, /Unknown source ids ignored: nonesuch/);
  assert.match(result.content[0].text, /No store on disk for: pi/);
});

test("scan_workspaces lists transcript files only for focused workspaces", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  const home = writePiHome();

  const broad = await withHome(home, () => tool.execute("t1", { sources: ["pi"] }));
  // Paths cost tokens, so a survey does not carry them.
  assert.ok(
    broad.details.workspaces.every((workspace) => workspace.session_files === undefined),
  );

  const focused = await withHome(home, () =>
    tool.execute("t2", { sources: ["pi"], paths: ["/Users/x/decks"] }),
  );
  assert.equal(focused.details.workspaces.length, 1);
  const [workspace] = focused.details.workspaces;
  assert.equal(workspace.session_files.length, 1);
  assert.match(workspace.session_files[0], /--Users-x-decks--[/\\]s\.jsonl$/);
  assert.equal(workspace.session_files_omitted, 0);
});

test("scan_workspaces integrates Codex evidence with Pi and reports skipped files", async (t) => {
  const home = writePiHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".codex", "sessions", "2026", "09", "01");
  mkdirSync(directory, { recursive: true });
  const codexPath = join(directory, "rollout.jsonl");
  writeFileSync(codexPath, [
    { type: "session_meta", payload: { cwd: "/Users/x/decks", source: "vscode" } },
    { type: "event_msg", payload: { type: "user_message", message: "Codex deck request" } },
    { type: "response_item", payload: { role: "user", content: "synthetic-injected-do-not-copy" } },
    { type: "response_item", payload: { type: "function_call_output", output: "synthetic-tool-output-do-not-copy" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + '\n{"broken":');
  writeFileSync(join(directory, "unsupported.jsonl.zst"), "synthetic compressed placeholder");
  const pi = await loadExtension();
  const tool = pi.tools.get("scan_workspaces");
  const result = await withHome(home, () => tool.execute("codex", {
    sources: ["pi", "codex"],
    roots: [join(home, ".pi", "agent", "sessions"), directory],
    keywords: ["Codex"],
    paths: ["/Users/x/decks"],
  }));
  assert.equal(result.details.sessions_found, 2);
  assert.equal(result.details.workspaces_found, 1);
  assert.equal(result.details.session_files_skipped, 1);
  const [workspace] = result.details.workspaces;
  assert.equal(workspace.sessions, 2);
  assert.equal(workspace.prompts_sampled, 2);
  assert.deepEqual(workspace.sources.map((source) => source.id).sort(), ["codex", "pi"]);
  assert.equal(workspace.prompts_complete, false);
  assert.deepEqual(workspace.sampling_issues, ["malformed_json"]);
  assert.deepEqual(workspace.matched_keywords, ["Codex"]);
  assert.ok(workspace.session_files.includes(codexPath));
  assert.equal(workspace.session_files.length, 2);
  assert.equal(result.details.sources_scanned.find((source) => source.id === "codex").files_skipped, 1);
  assert.match(result.content[0].text, /1 session files skipped/);
  assert.doesNotMatch(result.content[0].text, /synthetic-(injected|tool-output)-do-not-copy/);
});

test("scan_workspaces reports an unavailable Codex store without reading the real home", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rsih-codex-empty-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const pi = await loadExtension();
  const result = await withHome(home, () => pi.tools.get("scan_workspaces").execute("codex", { sources: ["codex"] }));
  assert.equal(result.details.sources_scanned[0].available, false);
  assert.equal(result.details.sessions_found, 0);
  assert.deepEqual(result.details.unknown_sources, []);
  assert.match(result.content[0].text, /No store on disk for: codex/);
});

/** Drive the selector component the way a terminal would. */
function fakeTuiContext(keys) {
  return {
    mode: "tui",
    ui: {
      async custom(factory) {
        let settled;
        const theme = { fg: (_color, text) => text };
        const tui = { requestRender() {} };
        const component = factory(tui, theme, {}, (value) => {
          settled = value;
        });
        // Render once so the cache path is exercised too.
        component.render(80);
        for (const key of keys) {
          component.handleInput(key);
          if (settled !== undefined) break;
          component.render(80);
        }
        return settled ?? null;
      },
      notify() {},
    },
  };
}

test("choose_workspaces returns exactly what the user ticked", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("choose_workspaces");
  assert.ok(tool, "choose_workspaces must be registered");

  const items = [
    { path: "/a", description: "first" },
    { path: "/b", description: "second" },
    { path: "/c", description: "third" },
  ];
  // Tick the first, move down twice, tick the third, confirm.
  const result = await tool.execute(
    "t2",
    { items, allow_notes: false },
    undefined,
    undefined,
    fakeTuiContext([" ", KEY_DOWN, KEY_DOWN, " ", KEY_ENTER]),
  );
  assert.deepEqual(result.details.selected, ["/a", "/c"]);
  assert.equal(result.details.cancelled, false);
});

test("choose_workspaces toggles everything with a and reports cancellation", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("choose_workspaces");
  const items = [{ path: "/a" }, { path: "/b" }];

  const all = await tool.execute(
    "t3",
    { items, allow_notes: false },
    undefined,
    undefined,
    fakeTuiContext(["a", KEY_ENTER]),
  );
  assert.deepEqual(all.details.selected, ["/a", "/b"]);

  const cancelled = await tool.execute(
    "t4",
    { items },
    undefined,
    undefined,
    fakeTuiContext([KEY_ESCAPE]),
  );
  assert.equal(cancelled.details.cancelled, true);
  assert.deepEqual(cancelled.details.selected, []);
  assert.match(cancelled.content[0].text, /do not pick for them/);

  // Enter with nothing ticked must not confirm an empty selection.
  const empty = await tool.execute(
    "t5",
    { items, allow_notes: false },
    undefined,
    undefined,
    fakeTuiContext([KEY_ENTER, KEY_ESCAPE]),
  );
  assert.equal(empty.details.cancelled, true);
});

test("choose_workspaces degrades loudly outside the TUI", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("choose_workspaces");
  const result = await tool.execute(
    "t6",
    { items: [{ path: "/a" }] },
    undefined,
    undefined,
    { mode: "print", ui: { notify() {} } },
  );
  assert.equal(result.details.interactive, false);
  assert.match(result.content[0].text, /unavailable in print mode/);
});

/* ------------------------------------------------------------ AskUserQuestion */

test("AskUserQuestion is carried by the Genome, not borrowed from Pi", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("AskUserQuestion");
  assert.ok(tool, "AskUserQuestion must be registered by the Genome's extension");
  // The released package has no such built-in, which is why the Genome ships it.
  assert.ok(!PI_BUILTIN_TOOL_NAMES.includes("AskUserQuestion"));
  // The guidance is what pushes the model to align instead of assuming.
  assert.ok(
    tool.promptGuidelines.some((line) => /materially change/.test(line)),
    "the tool must tell the model when asking is required",
  );
  assert.equal(tool.executionMode, "sequential");
});

test("AskUserQuestion returns the user's answers and the chat escape hatch", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("AskUserQuestion");
  const questions = [
    {
      question: "Which scenario is this Genome for?",
      options: [{ label: "Slide decks (Recommended)" }, { label: "Rust review" }],
    },
  ];

  const answered = await tool.execute(
    "a1",
    { questions },
    undefined,
    undefined,
    {
      hasUI: true,
      ui: {
        async custom() {
          return {
            type: "answers",
            answers: [
              { question: questions[0].question, answer: "Slide decks (Recommended)" },
            ],
          };
        },
      },
    },
  );
  assert.equal(answered.details.type, "answers");
  assert.match(answered.content[0].text, /Slide decks/);

  const chatted = await tool.execute("a2", { questions }, undefined, undefined, {
    hasUI: true,
    ui: {
      async custom() {
        return { type: "chat" };
      },
    },
  });
  assert.equal(chatted.details.type, "chat");
  assert.match(chatted.content[0].text, /chose to chat/);

  // Cancelling and running without a UI both have to fail loudly rather than
  // silently continuing on an invented answer.
  await assert.rejects(
    () =>
      tool.execute("a3", { questions }, undefined, undefined, {
        hasUI: true,
        ui: { async custom() {} },
      }),
    /cancelled/,
  );
  await assert.rejects(
    () => tool.execute("a4", { questions }, undefined, undefined, { hasUI: false }),
    /requires an interactive UI/,
  );
});

test("AskUserQuestion normalises plain-string option lists", async () => {
  const pi = await loadExtension();
  const tool = pi.tools.get("AskUserQuestion");
  const prepared = tool.prepareArguments({
    questions: [{ question: "Pick one", options: ["a", "b"] }],
  });
  assert.deepEqual(prepared.questions[0].options, [{ label: "a" }, { label: "b" }]);
  // Already-structured options pass through untouched.
  const structured = tool.prepareArguments({
    questions: [{ question: "Pick one", options: [{ label: "a", description: "d" }] }],
  });
  assert.deepEqual(structured.questions[0].options, [{ label: "a", description: "d" }]);
});

test("the ported dialog renders without a module-level theme singleton", async () => {
  const { AskUserQuestionDialog } = await import(
    pathToFileURL(join(bundle, "extension", "ask-user-question-dialog.ts")).href
  );
  // The dialog takes its theme through the constructor, but Pi's shared
  // `keyHint` helpers still read the process-wide theme that a real TUI session
  // initialises at startup.
  initTheme();
  let settled;
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };
  const dialog = new AskUserQuestionDialog(
    [{ question: "Which scenario?", options: [{ label: "Slide decks" }] }],
    theme,
    (result) => {
      settled = result;
    },
    { terminal: { columns: 80 }, requestRender() {} },
  );
  const lines = dialog.render(80).join("\n");
  assert.match(lines, /Which scenario\?/);
  assert.match(lines, /Slide decks/);
  assert.equal(settled, undefined, "rendering must not settle the dialog");

  // Enter on a single single-select question submits straight away.
  dialog.handleInput(KEY_ENTER);
  assert.equal(settled?.type, "answers");
  assert.equal(settled.answers[0].answer, "Slide decks");
});

/**
 * Options are what the model thought of. Whatever they are, the user has to be
 * able to answer in their own words, so the free-text row is unconditional and
 * reads as `Other` -- there is no flag that removes it.
 */
test("an options question always offers Other", async () => {
  const { AskUserQuestionDialog } = await import(
    pathToFileURL(join(bundle, "extension", "ask-user-question-dialog.ts")).href
  );
  initTheme();
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };
  const dialog = new AskUserQuestionDialog(
    [
      {
        question: "Which scenario?",
        options: [{ label: "Slide decks" }],
        placeholder: "Describe it in your own words",
        allowCustomAnswer: false,
      },
    ],
    theme,
    () => {},
    { terminal: { columns: 80 }, requestRender() {} },
  );
  const lines = dialog.render(80).join("\n");
  assert.match(lines, /2\. Other/);
  // The placeholder becomes the hint under that row rather than its label.
  assert.match(lines, /Describe it in your own words/);
  assert.match(lines, /3\. Chat about this/);
});

/* ------------------------------------------------------------- the boot nudge */

test("the boot nudge fires once on a fresh TUI session and never on a resumed one", async () => {
  const pi = await loadExtension();
  const handler = pi.handlers.get("session_start");
  assert.ok(handler, "session_start must be handled");

  const ctx = (entries) => ({
    mode: "tui",
    ui: { notify() {} },
    isIdle: () => true,
    sessionManager: { getEntries: () => entries },
  });

  handler({ type: "session_start", reason: "startup" }, ctx([]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, "harness-rsi.boot");
  assert.equal(pi.sent[0].message.display, false);
  assert.equal(pi.sent[0].options.triggerTurn, true);

  // A reload must not interrupt the conversation again.
  handler({ type: "session_start", reason: "reload" }, ctx([]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pi.sent.length, 1);
});

test("the boot nudge stays quiet for a session that already has history", async () => {
  const pi = await loadExtension();
  const handler = pi.handlers.get("session_start");
  handler(
    { type: "session_start", reason: "resume" },
    {
      mode: "tui",
      ui: { notify() {} },
      sessionManager: { getEntries: () => [{ type: "message" }] },
    },
  );
  // Non-TUI modes must never inject a turn either.
  handler(
    { type: "session_start", reason: "startup" },
    { mode: "print", ui: { notify() {} }, sessionManager: { getEntries: () => [] } },
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pi.sent.length, 0);
});

test("/genome-new is the manual entry point", async () => {
  const pi = await loadExtension();
  const command = pi.commands.get("genome-new");
  assert.ok(command, "genome-new must be registered");
  await command.handler("making slide decks", {
    isIdle: () => true,
    ui: { notify() {} },
  });
  assert.equal(pi.sent.at(-1).kind, "user");
  assert.match(pi.sent.at(-1).content, /making slide decks/);
});

/* Guard the raw key sequences the selector tests rely on. */
test("the selector test keys are the sequences a terminal sends", () => {
  assert.ok(matchesKey(KEY_ENTER, "enter"));
  assert.ok(matchesKey(KEY_DOWN, "down"));
  assert.ok(matchesKey(KEY_ESCAPE, "escape"));
});
