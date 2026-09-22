import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createGenomeSession,
  startupPromptRecord,
  switchedSystemPrompt,
  unswitchableDifferences,
} from "../src/harness/genome-session.ts";
import { availableGenomeNames, genomeNamesIn } from "../src/harness/genome-loader.ts";
import { genomeActiveToolNames } from "../src/pi-cli-runtime.ts";

/**
 * Pi assembles a system prompt as preamble, then appended text, then project
 * context. These fixtures stand in for that shape so the delta can be checked
 * without booting an agent.
 */
const PREAMBLE = "You are pi, a coding agent.\n\nGuidelines:\n- be terse";
const CONTEXT = "<project_context>\nAGENTS.md says hello\n</project_context>";

function assembled({ customPrompt, appendPrompt }) {
  return [customPrompt ?? PREAMBLE, appendPrompt, CONTEXT]
    .filter(Boolean)
    .join("\n\n");
}

function options({ customPrompt, appendPrompt }) {
  return {
    cwd: "/repo",
    customPrompt,
    appendSystemPrompt: appendPrompt,
  };
}

test("an unchanged Genome pins no override", () => {
  const startup = startupPromptRecord({ appendPrompt: "DEV MODE" });
  assert.equal(
    switchedSystemPrompt({
      base: assembled({ appendPrompt: "DEV MODE" }),
      options: options({ appendPrompt: "DEV MODE" }),
      startup,
      target: { appendPrompt: "DEV MODE" },
    }),
    undefined,
  );
});

test("swapping appended instructions removes the old ones exactly", () => {
  // The shape both shipped Genomes use: append only, no base replacement.
  const startup = startupPromptRecord({ appendPrompt: "DEV MODE\nship code" });
  const switched = switchedSystemPrompt({
    base: assembled({ appendPrompt: "DEV MODE\nship code" }),
    options: options({ appendPrompt: "DEV MODE\nship code" }),
    startup,
    target: { appendPrompt: "DEBATE MODE\nchallenge everything" },
  });

  assert.deepEqual(switched.caveats, []);
  // Byte-identical to what a restart under the new Genome would have produced.
  assert.equal(
    switched.prompt,
    assembled({ appendPrompt: "DEBATE MODE\nchallenge everything" }),
  );
  // The decisive property: no trace of the previous Genome is left behind.
  assert.equal(switched.prompt.includes("DEV MODE"), false);
});

test("a Genome that appends nothing drops the previous instructions", () => {
  const startup = startupPromptRecord({ appendPrompt: "DEV MODE" });
  const switched = switchedSystemPrompt({
    base: assembled({ appendPrompt: "DEV MODE" }),
    options: options({ appendPrompt: "DEV MODE" }),
    startup,
    target: {},
  });

  assert.deepEqual(switched.caveats, []);
  assert.equal(switched.prompt.includes("DEV MODE"), false);
  assert.equal(switched.prompt, assembled({}));
});

test("swapping a base system prompt replaces it in place", () => {
  const startup = startupPromptRecord({
    systemPrompt: "You only plan.",
    appendPrompt: "DEV MODE",
  });
  const switched = switchedSystemPrompt({
    base: assembled({ customPrompt: "You only plan.", appendPrompt: "DEV MODE" }),
    options: options({ customPrompt: "You only plan.", appendPrompt: "DEV MODE" }),
    startup,
    target: { systemPrompt: "You only argue.", appendPrompt: "DEBATE MODE" },
  });

  assert.deepEqual(switched.caveats, []);
  assert.equal(
    switched.prompt,
    assembled({ customPrompt: "You only argue.", appendPrompt: "DEBATE MODE" }),
  );
  assert.equal(switched.prompt.includes("You only plan."), false);
  // Pi's default preamble was never in this prompt and must not appear now.
  assert.equal(switched.prompt.includes("You are pi"), false);
});

test("adopting a base prompt over Pi's default preamble is reported, not hidden", () => {
  // Pi's preamble is generated text this process never authored, so it cannot
  // be stripped. The new instructions still have to arrive -- but the user is
  // owed the fact that this is not equivalent to a restart.
  const startup = startupPromptRecord({ appendPrompt: "DEV MODE" });
  const switched = switchedSystemPrompt({
    base: assembled({ appendPrompt: "DEV MODE" }),
    options: options({ appendPrompt: "DEV MODE" }),
    startup,
    target: { systemPrompt: "You only argue." },
  });

  assert.equal(switched.prompt.includes("You only argue."), true);
  assert.equal(switched.prompt.includes("DEV MODE"), false);
  assert.equal(switched.caveats.length, 1);
  assert.match(switched.caveats[0], /restart/);
});

test("dropping a base prompt cannot resurrect Pi's default, and says so", () => {
  const startup = startupPromptRecord({ systemPrompt: "You only plan." });
  const switched = switchedSystemPrompt({
    base: assembled({ customPrompt: "You only plan." }),
    options: options({ customPrompt: "You only plan." }),
    startup,
    target: { appendPrompt: "DEBATE MODE" },
  });

  assert.equal(switched.prompt.includes("You only plan."), false);
  assert.equal(switched.prompt.includes("DEBATE MODE"), true);
  assert.equal(switched.caveats.length, 1);
  assert.match(switched.caveats[0], /cannot restore/);
});

test("a prompt owned by someone else is added to, never overwritten", () => {
  // `--system-prompt` on the command line, or a SYSTEM.md: Pi's loader is not
  // reporting the text this process put on argv, so the base is not ours to
  // rewrite. An explicit user choice outranks the Genome.
  const startup = startupPromptRecord({ systemPrompt: "You only plan." });
  const switched = switchedSystemPrompt({
    base: assembled({ customPrompt: "The user's own prompt." }),
    options: options({ customPrompt: "The user's own prompt." }),
    startup,
    target: { systemPrompt: "You only argue." },
  });

  assert.equal(switched.prompt.includes("The user's own prompt."), true);
  assert.equal(switched.prompt.includes("You only argue."), true);
  assert.equal(switched.caveats.length, 1);
  assert.match(switched.caveats[0], /owned by something other than the Genome/);
});

test("appended text is matched as a whole, however Pi reported it", () => {
  // Pi hands back `appendSystemPrompt` as an array when several --append flags
  // were given. The record stores the joined form, so the comparison has to
  // normalize or every switch would look foreign-owned.
  const startup = startupPromptRecord({ appendPrompt: "ONE\n\nTWO" });
  const switched = switchedSystemPrompt({
    base: assembled({ appendPrompt: "ONE\n\nTWO" }),
    options: { cwd: "/repo", appendSystemPrompt: ["ONE", "TWO"] },
    startup,
    target: { appendPrompt: "DEBATE MODE" },
  });

  assert.deepEqual(switched.caveats, []);
  assert.equal(switched.prompt, assembled({ appendPrompt: "DEBATE MODE" }));
});

test("differing extensions are reported as unswitchable", () => {
  const differences = unswitchableDifferences(
    { extensions: ["./extension/dev.ts"] },
    { extensions: ["./extension/debate.ts"] },
  );
  assert.equal(differences.length, 1);
  // Both halves matter: one extension is stuck on, the other never arrived.
  assert.match(differences[0], /still loaded: \.\/extension\/dev\.ts/);
  assert.match(differences[0], /not loaded: \.\/extension\/debate\.ts/);
});

test("identical extensions are not reported, whatever their shape or order", () => {
  assert.deepEqual(unswitchableDifferences({}, {}), []);
  assert.deepEqual(
    unswitchableDifferences(
      { extensions: ["./a.ts", "./b.ts"] },
      { extensions: [{ source: "./b.ts" }, "./a.ts"] },
    ),
    [],
  );
});

test("the holder repoints, and hands its announcement over exactly once", () => {
  // This is what makes a switch visible to a re-invoked extension factory: the
  // holder outlives the factory, so the next invocation reads the new Genome.
  const dev = { label: "dev", genome: { genome_id: "harness:dev" } };
  const debate = { label: "debate", genome: { genome_id: "harness:debate" } };
  const session = createGenomeSession(dev, startupPromptRecord({}));

  assert.equal(session.current().label, "dev");
  assert.equal(session.takeAnnouncement(), undefined);

  session.switchTo(debate, { from: "dev", to: "debate", caveats: [] });
  assert.equal(session.current().label, "debate");

  // Consumed by the post-reload session_start; a second session_start (a later
  // /reload, say) must not replay a switch that already happened.
  assert.deepEqual(session.takeAnnouncement(), {
    from: "dev",
    to: "debate",
    caveats: [],
  });
  assert.equal(session.takeAnnouncement(), undefined);
});

test("the other argv-only fields are reported, and theme is not", () => {
  assert.deepEqual(
    unswitchableDifferences(
      { resources: { isolate: true } },
      { resources: { isolate: false } },
    ).length,
    1,
  );
  assert.match(
    unswitchableDifferences({}, { appearance: { no_themes: true } })[0],
    /no_themes/,
  );
  // theme reaches Pi through settings.json too, and reload re-reads that.
  assert.deepEqual(
    unswitchableDifferences(
      { appearance: { theme: "dark" } },
      { appearance: { theme: "light" } },
    ),
    [],
  );
});

test("switching away releases tools the previous Genome had disabled", () => {
  // Reload carries the active tool set forward, so a Genome that disabled a
  // tool would keep it disabled after it stopped running. Caught end to end:
  // dev -> debate -> dev left `write` off, because dev declares no tools at all
  // and so never reasserted anything.
  const debate = { tools: [{ name: "write", enabled: false }] };
  const dev = {};
  const all = ["read", "bash", "edit", "write"];

  const narrowed = genomeActiveToolNames(all, all, debate);
  assert.deepEqual(narrowed, ["read", "bash", "edit"]);

  assert.deepEqual(
    genomeActiveToolNames(narrowed, all, dev, debate),
    ["read", "bash", "edit", "write"],
  );
});

test("a tool the incoming Genome also disables is not released", () => {
  const all = ["read", "write"];
  const previous = { tools: [{ name: "write", enabled: false }] };
  assert.deepEqual(
    genomeActiveToolNames(["read"], all, previous, previous),
    ["read"],
  );
  // An explicit re-enable wins over the previous disable, too.
  assert.deepEqual(
    genomeActiveToolNames(
      ["read"],
      all,
      { tools: [{ name: "write", enabled: true }] },
      previous,
    ),
    ["read", "write"],
  );
});

test("a Genome that mentions no tools still pins nothing on a fresh start", () => {
  // The no-op case has to stay a no-op: returning a list here would impose a
  // tool set on a Genome that never asked for one.
  assert.equal(genomeActiveToolNames(["read"], ["read", "write"], {}), undefined);
  assert.equal(
    genomeActiveToolNames(["read"], ["read", "write"], {}, { tools: [] }),
    undefined,
  );
});

test("Genome names come back from every layer, deduplicated by lookup order", () => {
  const root = mkdtempSync(join(tmpdir(), "rsih-names-"));
  try {
    const project = join(root, "project", ".rsih", "genomes");
    const home = join(root, "home", ".rsih", "genomes");
    const seeds = join(root, "pkg", "genomes");
    for (const directory of [project, home, seeds]) {
      mkdirSync(directory, { recursive: true });
    }
    // A single-file Genome, a bundle, and a directory that is not a bundle.
    writeFileSync(join(project, "dev.json"), "{}", "utf8");
    mkdirSync(join(home, "debate"), { recursive: true });
    writeFileSync(join(home, "debate", "genome.json"), "{}", "utf8");
    mkdirSync(join(home, "not-a-genome"), { recursive: true });
    // Same name in the seed layer: the user copy is what would load.
    mkdirSync(join(seeds, "debate"), { recursive: true });
    writeFileSync(join(seeds, "debate", "genome.json"), "{}", "utf8");

    assert.deepEqual(genomeNamesIn(project), [{ name: "dev", bundle: false }]);
    assert.deepEqual(genomeNamesIn(home), [{ name: "debate", bundle: true }]);
    assert.deepEqual(genomeNamesIn(join(root, "missing")), []);

    assert.deepEqual(
      availableGenomeNames({
        cwd: join(root, "project"),
        homeDirectory: join(root, "home"),
        packageDirectory: join(root, "pkg"),
      }),
      ["debate", "dev"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
