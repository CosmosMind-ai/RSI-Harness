import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createDefaultHarnessGenome,
  createHarnessGenome,
} from "../src/index.ts";
import { rsiHeaderLines, RsiEditor } from "../src/tui/rsih-tui.ts";
import {
  genomeAppearanceArgs,
  genomeActiveToolNames,
  genomeFooterStatus,
  parseCliArgs,
} from "../src/pi-cli-runtime.ts";
import {
  genomeResourceIsolationArgs,
  projectGenomeResources,
} from "../src/harness/pi-projection.ts";
import {
  expandGenomeShorthand,
  genomeShorthandReference,
} from "../src/cli/genome-shorthand.ts";

const codeDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

function runCli(directory, args) {
  return spawnSync(
    process.execPath,
    [join(codeDirectory, "src", "cli.ts"), ...args],
    {
      cwd: codeDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        RSIH_CODING_AGENT_DIR: join(directory, ".rsih-agent"),
      },
    },
  );
}

/** Mirror of Pi's default session directory, which RSIH no longer overrides. */
function piSessionDir(directory) {
  const canonical = realpathSync(directory);
  const encoded = `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(directory, ".rsih-agent", "sessions", encoded);
}

function sessionEntries(sessionDirectory) {
  const files = readdirSync(sessionDirectory).filter((name) =>
    name.endsWith(".jsonl"),
  );
  assert.equal(files.length, 1);
  return readFileSync(join(sessionDirectory, files[0]), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("CLI translates RSIH compatibility flags and preserves Pi flags", () => {
  assert.deepEqual(
    parseCliArgs([
      "-p",
      "Say ok.",
      "--run-id",
      "cli-args",
      "--profile",
      "test-provider",
      "--model",
      "test-model",
      "--json",
    ]),
    {
      cwd: ".",
      maxTurns: undefined,
      json: true,
      newSession: false,
      profile: "test-provider",
      piArgs: [
        "-p",
        "Say ok.",
        "--session-id",
        "cli-args",
        "--provider",
        "test-provider",
        "--model",
        "test-model",
        "--mode",
        "json",
      ],
    },
  );
});

test("Genome appearance translates to Pi theme flags without overriding CLI flags", () => {
  const genome = createHarnessGenome({
    appearance: { theme: "dark", no_themes: true },
  });
  assert.deepEqual(genomeAppearanceArgs(genome), [
    "--use-theme",
    "dark",
    "--no-themes",
  ]);
  assert.deepEqual(
    genomeAppearanceArgs(genome, ["--use-theme", "light", "--no-themes"]),
    [],
  );
});

test("Genome theme paths reach Pi through resource discovery", () => {
  const genome = createHarnessGenome({
    appearance: { themes: ["themes/coding.json"] },
    skills: [{ source: "./skills/review" }],
    prompt_templates: [
      { source: "./prompts" },
      { name: "plan", content: "Plan first." },
    ],
  });
  const projected = projectGenomeResources(genome, (path) =>
    `/tmp/project/${path.replace(/^\.\//, "")}`,
  );
  assert.deepEqual(projected.themePaths, ["/tmp/project/themes/coding.json"]);
  assert.deepEqual(projected.skillPaths, ["/tmp/project/skills/review"]);
  // Inline templates become commands instead of discovered files.
  assert.deepEqual(projected.promptPaths, ["/tmp/project/prompts"]);
});

test("resource isolation is opt-in and never hides context files", () => {
  assert.deepEqual(genomeResourceIsolationArgs(createHarnessGenome()), []);
  assert.deepEqual(
    genomeResourceIsolationArgs(
      createHarnessGenome({ resources: { isolate: true } }),
    ),
    ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"],
  );
  assert.deepEqual(
    genomeResourceIsolationArgs(
      createHarnessGenome({ resources: { isolate: true } }),
      ["--no-skills"],
    ),
    ["--no-prompt-templates", "--no-themes", "--no-extensions"],
  );
});

test("Genome tools patch Pi's active set instead of replacing it", () => {
  const all = ["read", "ls", "bash", "load_skill", "mcp_search"];

  // A Genome with no tools opinion leaves Pi's selection untouched.
  assert.equal(
    genomeActiveToolNames(all, all, createHarnessGenome()),
    undefined,
  );

  // Disabling one tool keeps every other tool Pi had enabled.
  assert.deepEqual(
    genomeActiveToolNames(
      all,
      all,
      createHarnessGenome({ tools: [{ name: "bash", enabled: false }] }),
    ),
    ["read", "ls", "load_skill", "mcp_search"],
  );

  // Enabling a tool Pi left off adds it; `list` still maps to Pi's `ls`.
  assert.deepEqual(
    genomeActiveToolNames(
      ["read"],
      all,
      createHarnessGenome({
        tools: [{ name: "list", enabled: true }, { name: "bash", enabled: true }],
      }),
    ),
    ["read", "ls", "bash"],
  );
});

test("Genome footer status is labeled and purple", () => {
  assert.equal(genomeFooterStatus("coding"), "\u001b[35mGenome: coding\u001b[39m");
});

test("RSIH TUI header includes DNA logo and runtime identity", () => {
  const lines = rsiHeaderLines(
    60,
    {
      cwd: join(homedir(), "project"),
      model: "gpt-5.6-sol",
      genome: "coding",
      version: "0.1.0",
    },
    (text) => `\u001b[35m${text}\u001b[39m`,
    (text) => `\u001b[1m${text}\u001b[0m`,
  );
  const plain = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.match(plain, /╭─+╮/);
  assert.match(plain, /[▀▄█]/);
  assert.match(plain, /▄▄▄▄/);
  assert.match(plain, /Workspace: ~\/project/);
  assert.match(plain, /Model: gpt-5\.6-sol/);
  assert.match(plain, /Genome: coding/);
  assert.match(plain, /Version: 0\.1\.0/);
  assert.ok(lines[0].startsWith("\u001b[35m"));
});

test("RSIH TUI header lists the loaded resources and nothing transient", () => {
  const lines = rsiHeaderLines(
    60,
    {
      cwd: join(homedir(), "project"),
      model: "gpt-5.6-sol",
      genome: "coding",
      version: "0.1.0",
      resources: {
        skills: ["code-review"],
        extensions: ["git.ts"],
      },
    },
    (text) => text,
    (text) => text,
  );
  const plain = lines.join("\n");
  assert.match(plain, /\[Skills\]/);
  assert.match(plain, /code-review/);
  assert.match(plain, /\[Extensions\]/);
  assert.match(plain, /git\.ts/);
  assert.match(plain, /│/);
  assert.match(plain, /A Genome-driven runtime f/);
  assert.match(plain, /│\s+─{3,}\s+│/);
  assert.doesNotMatch(plain, /none loaded/);
  assert.doesNotMatch(plain, /Skills:/);
  assert.doesNotMatch(plain, /Extensions:/);
});

test("RSIH TUI keeps a fixed column divider and compacts long workspaces", () => {
  const lines = rsiHeaderLines(
    120,
    {
      cwd: join(homedir(), "Documents/cosmos/dopapers/rsih"),
      model: "gpt-5.6-sol",
      genome: "default",
      version: "0.1.0",
      resources: { skills: [], extensions: [] },
    },
    (text) => text,
    (text) => text,
  );
  const plain = lines.join("\n");
  const dividerPositions = lines
    .slice(1, -1)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").indexOf("│", 1));
  assert.equal(new Set(dividerPositions).size, 1);
  assert.match(plain, /Workspace: ~\/\.\.\.\/dopapers\/rsih/);
});

test("RSIH editor preserves Pi cursor marker when padding is zero", () => {
  const tui = { terminal: { rows: 42 }, requestRender() {} };
  const theme = {
    borderColor: (text) => `\u001b[35m${text}\u001b[39m`,
    selectList: {},
  };
  const keybindings = { matches: () => false };
  const editor = new RsiEditor(tui, theme, keybindings);
  editor.focused = true;
  editor.setPaddingX(0);

  const inputLine = editor.render(60)[1]!;
  assert.match(inputLine, /^\u001b\[35m>\u001b\[39m\u001b_pi:c\u0007/);
  assert.doesNotMatch(inputLine, /^.*>\u001b\[39m_pi:c/);
  assert.ok(visibleWidth(inputLine) <= 60);
});

/**
 * RSIH replaces one padding cell with its prompt character and nothing else.
 * It used to also strip Pi's autocomplete rows off the end of the editor so the
 * header could redraw them, which put the slash-command list up in the startup
 * banner instead of under the input box.
 */
test("RSIH editor keeps every row Pi's editor renders", () => {
  const tui = { terminal: { rows: 42 }, requestRender() {} };
  const theme = {
    borderColor: (text) => `\u001b[35m${text}\u001b[39m`,
    selectList: {},
  };
  const keybindings = { matches: () => false };
  const editor = new RsiEditor(tui, theme, keybindings);
  editor.focused = true;

  const upstream = Object.getPrototypeOf(RsiEditor.prototype).render.call(
    editor,
    60,
  );  assert.equal(editor.render(60).length, upstream.length);
  assert.equal(typeof editor.getAutocompleteLines, "undefined");
});

test("checked-in default Genome leaves Pi defaults unchanged", () => {
  const checkedIn = JSON.parse(
    readFileSync(
      join(codeDirectory, "config", "harness.default.json"),
      "utf8",
    ),
  );
  const genome = createDefaultHarnessGenome();

  assert.deepEqual(checkedIn, genome);
  // The default Genome must not carry a single behavioral field: anything it
  // declared would be silently imposed on a bare `rsih` run.
  assert.deepEqual(Object.keys(genome).sort(), [
    "genome_id",
    "genome_schema_version",
    "parent_id",
    "version",
  ]);
});

test("CLI runs through Pi print mode and stores Genome in Pi JSONL", () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-cli-"));
  const providersPath = join(directory, "providers.json");
  const genomePath = join(directory, "genome.json");
  writeFileSync(
    providersPath,
    JSON.stringify({
      mock: {
        kind: "mock",
        model: "mock-cli",
        mock_responses: ["cli ok"],
      },
    }),
    "utf8",
  );
  writeFileSync(
    genomePath,
    JSON.stringify(
      createHarnessGenome({
        genome_id: "harness:cli",
        model: { profile: "mock", id: "mock-cli" },
      }),
    ),
    "utf8",
  );

  const result = runCli(directory, [
    "-p",
    "Say ok.",
    "--run-id",
    "cli-test",
    "--config",
    providersPath,
    "--genome",
    genomePath,
    "--cwd",
    directory,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "cli ok");
  const entries = sessionEntries(piSessionDir(directory));
  assert.equal(entries[0].id, "cli-test");
  assert.ok(
    entries.some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "rsih.genome" &&
        entry.data.genome_id === "harness:cli",
    ),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.content.some(
          (content) => content.type === "text" && content.text === "cli ok",
        ),
    ),
  );
});

/**
 * Driving a Genome from the command line: one `--run-id` names a conversation,
 * and every later invocation with that id appends to it. The Genome is named
 * once and restored from the session afterwards, so a script does not have to
 * repeat it -- and cannot accidentally change it half way through.
 */
test("a run id keeps one conversation alive across separate invocations", () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-cli-runid-"));
  const providersPath = join(directory, "providers.json");
  const genomesDirectory = join(directory, ".rsih", "genomes");
  mkdirSync(genomesDirectory, { recursive: true });
  writeFileSync(
    providersPath,
    JSON.stringify({
      notes: { kind: "mock", model: "notes-model", mock_responses: ["noted"] },
    }),
    "utf8",
  );
  writeFileSync(
    join(genomesDirectory, "notes.json"),
    JSON.stringify(
      createHarnessGenome({
        genome_id: "harness:notes",
        // Only reachable through the Genome, so a reply proves it was applied.
        model: { profile: "notes", id: "notes-model" },
      }),
    ),
    "utf8",
  );

  const first = runCli(directory, [
    "-p",
    "First.",
    "--config",
    providersPath,
    "--genome",
    "notes",
    "--run-id",
    "conversation-1",
    "--cwd",
    directory,
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), "noted");

  // No --genome this time: the session carries it.
  const second = runCli(directory, [
    "-p",
    "Second.",
    "--config",
    providersPath,
    "--run-id",
    "conversation-1",
    "--cwd",
    directory,
  ]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), "noted");

  const entries = sessionEntries(piSessionDir(directory));
  assert.equal(entries[0].id, "conversation-1", "--run-id names the session");
  assert.deepEqual(
    entries
      .filter((entry) => entry.type === "message" && entry.message.role === "user")
      .map((entry) => entry.message.content[0].text),
    ["First.", "Second."],
    "the second invocation appends instead of starting over",
  );
  assert.equal(
    entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "rsih.genome",
    ).length,
    1,
    "the Genome is recorded once, not re-stamped every turn",
  );
});

test("CLI discovers a named Genome and resumes its Pi session", () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-cli-genome-"));
  const providersPath = join(directory, "providers.json");
  const genomesDirectory = join(directory, ".rsih", "genomes");
  mkdirSync(genomesDirectory, { recursive: true });
  writeFileSync(
    providersPath,
    JSON.stringify({
      coding: {
        kind: "mock",
        model: "genome-model",
        mock_responses: ["named genome ok"],
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(genomesDirectory, "coding.json"),
    JSON.stringify(
      createHarnessGenome({
        genome_id: "harness:coding",
        model: { profile: "coding", id: "genome-model" },
        skills: [
          {
            name: "coding",
            description: "Coding workflow",
            content: "Use a focused coding workflow.",
          },
        ],
      }),
    ),
    "utf8",
  );

  const first = runCli(directory, [
    "-p",
    "First.",
    "--config",
    providersPath,
    "--genome",
    "coding",
    "--cwd",
    directory,
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), "named genome ok");
  const firstEntries = sessionEntries(piSessionDir(directory));
  const sessionId = firstEntries[0].id;

  const second = runCli(directory, [
    "-p",
    "Second.",
    "--continue",
    "--config",
    providersPath,
    "--cwd",
    directory,
  ]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), "named genome ok");
  const entries = sessionEntries(piSessionDir(directory));
  assert.equal(entries[0].id, sessionId);
  assert.equal(
    entries.filter(
      (entry) =>
        entry.type === "message" && entry.message.role === "user",
    ).length,
    2,
  );
  assert.equal(
    entries.filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "rsih.genome",
    ).length,
    1,
  );
});

test("the binary ships no changelog, not Pi's", () => {
  // Pi resolves CHANGELOG.md next to the package.json it reads, so pairing
  // Pi's release notes with RSIH's version makes every Pi release look unseen
  // and replays the "What's New" wall on every start. Shipping none is the
  // intended state: Pi treats a missing changelog as no entries.
  const buildScript = readFileSync(
    join(codeDirectory, "scripts", "build-binary.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    buildScript,
    /copyFileSync\([^)]*CHANGELOG|cpSync\([^)]*CHANGELOG/,
    "no changelog may ship with the binary",
  );
});

test("a leading :, :: or + is shorthand for --genome", () => {
  for (const argument of ["+coding", ":coding", "::coding"]) {
    assert.deepEqual(expandGenomeShorthand([argument]), ["--genome", "coding"]);
  }
  // The rest of argv is untouched, so the shorthand composes with Pi's flags.
  assert.deepEqual(expandGenomeShorthand(["+coding", "-p", "go"]), [
    "--genome",
    "coding",
    "-p",
    "go",
  ]);
  // Path references work too; resolution is the loader's job, not the parser's.
  assert.deepEqual(expandGenomeShorthand([":./my-genome"]), [
    "--genome",
    "./my-genome",
  ]);
  // Expanding twice must not add a second --genome.
  assert.deepEqual(
    expandGenomeShorthand(expandGenomeShorthand(["+coding"])),
    ["--genome", "coding"],
  );
});

test("the Genome shorthand does not swallow messages or option values", () => {
  // Pi takes free-form messages as positional arguments and most of its options
  // take values, so only the launch position is unambiguous.
  assert.deepEqual(expandGenomeShorthand(["--thinking", "+x"]), [
    "--thinking",
    "+x",
  ]);
  assert.deepEqual(expandGenomeShorthand(["add", "+1", "to", "the", "counter"]), [
    "add",
    "+1",
    "to",
    "the",
    "counter",
  ]);
  // A bare sigil names no Genome, and whitespace means the argument is prose.
  assert.equal(genomeShorthandReference("+"), undefined);
  assert.equal(genomeShorthandReference(":"), undefined);
  assert.equal(genomeShorthandReference("::"), undefined);
  assert.equal(genomeShorthandReference(": coding"), undefined);
  assert.equal(genomeShorthandReference("coding"), undefined);
  assert.equal(genomeShorthandReference(undefined), undefined);
  assert.deepEqual(expandGenomeShorthand([]), []);
});

test("RSIH options accept both --option value and --option=value", () => {
  // The equals spelling used to fall through to Pi untouched, which silently
  // started the default Genome instead of the requested one.
  assert.equal(parseCliArgs(["--genome=coding"]).genome, "coding");
  assert.equal(parseCliArgs(["--genome", "coding"]).genome, "coding");
  assert.equal(parseCliArgs(["--max-turns=3"]).maxTurns, 3);
  assert.equal(parseCliArgs(["--cwd=/tmp"]).cwd, "/tmp");
  assert.deepEqual(parseCliArgs(["--profile=local"]).piArgs, [
    "--provider",
    "local",
  ]);
  assert.equal(parseCliArgs(["--genome=coding"]).piArgs.length, 0);
  assert.throws(() => parseCliArgs(["--genome="]), /--genome requires a value/);
});

test("launching with the +name shorthand resolves that Genome", () => {
  // The unit tests cover the rewrite; this covers the wiring in src/cli.ts,
  // which is the part that can silently not be called.
  const directory = mkdtempSync(join(tmpdir(), "rsih-cli-shorthand-"));
  const providersPath = join(directory, "providers.json");
  const genomesDirectory = join(directory, ".rsih", "genomes");
  mkdirSync(genomesDirectory, { recursive: true });
  writeFileSync(
    providersPath,
    JSON.stringify({
      coding: {
        kind: "mock",
        model: "genome-model",
        mock_responses: ["shorthand ok"],
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(genomesDirectory, "coding.json"),
    JSON.stringify(
      createHarnessGenome({
        genome_id: "harness:coding-shorthand",
        model: { profile: "coding", id: "genome-model" },
      }),
    ),
    "utf8",
  );

  const result = runCli(directory, [
    "+coding",
    "-p",
    "First.",
    "--config",
    providersPath,
    "--cwd",
    directory,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "shorthand ok");
  assert.ok(
    sessionEntries(piSessionDir(directory)).some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "rsih.genome" &&
        entry.data.genome_id === "harness:coding-shorthand",
    ),
  );
});

test("installing carries the whole payload, not just the executable", () => {
  // The binary resolves its version, built-in Genome seeds and themes relative
  // to its own directory. Copying only the executable onto the PATH produced an
  // rsih that reported 0.0.0 and could not find `paperlab` at all, so the install
  // step has to move the payload and link to it.
  const buildScript = readFileSync(
    join(codeDirectory, "scripts", "build-binary.ts"),
    "utf8",
  );
  assert.match(buildScript, /cpSync\(dirname\(outputPath\), libDirectory/);
  assert.match(buildScript, /symlinkSync\(target, link\)/);
  assert.doesNotMatch(
    buildScript,
    /copyFileSync\(outputPath, installPath\)/,
    "install must not copy the bare executable onto the PATH",
  );

  // install.sh must not reimplement any of that.
  const installScript = readFileSync(join(codeDirectory, "install.sh"), "utf8");
  assert.match(installScript, /npm run --silent install:binary/);
  // And it has to prove the payload arrived rather than trust the copy.
  assert.match(installScript, /rsih" genome validate paperlab/);
});
