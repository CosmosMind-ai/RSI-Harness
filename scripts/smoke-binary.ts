import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executableName = process.platform === "win32" ? "rsih.exe" : "rsih";
const binaryPath = resolve(
  process.env.RSIH_BINARY ?? join("dist", executableName),
);
if (!existsSync(binaryPath)) {
  throw new Error(`Binary does not exist: ${binaryPath}`);
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "rsih-binary-"));
const configPath = join(runtimeDirectory, "providers.json");
const genomesDirectory = join(runtimeDirectory, ".rsih", "genomes");
const extensionsDirectory = join(runtimeDirectory, "extensions");
const extensionPath = join(extensionsDirectory, "echo.ts");
mkdirSync(genomesDirectory, { recursive: true });
mkdirSync(extensionsDirectory, { recursive: true });
writeFileSync(
  configPath,
  JSON.stringify({
    mock: {
      kind: "mock",
      model: "binary-smoke",
      mock_responses: [
        {
          text: "",
          tool_calls: [
            {
              id: "binary-extension-call",
              name: "binary_echo",
              arguments: { value: "binary tool ok" },
            },
          ],
        },
        "binary ok",
      ],
    },
  }),
  "utf8",
);
writeFileSync(
  extensionPath,
  [
    "export default function extension(pi) {",
    "  pi.registerTool({",
    '    name: "binary_echo",',
    '    label: "Binary echo",',
    '    description: "Echo a value.",',
    '    parameters: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } },',
    "    async execute(_id, params) {",
    '      return { content: [{ type: "text", text: params.value }], details: {} };',
    "    },",
    "  });",
    "}",
  ].join("\n"),
  "utf8",
);
const genome = JSON.parse(
  readFileSync(resolve("config", "harness.default.json"), "utf8"),
);
genome.genome_id = "harness:binary-smoke";
genome.model = { profile: "mock", id: "binary-smoke" };
genome.extensions = [{ source: "../../extensions/echo.ts" }];
writeFileSync(
  join(genomesDirectory, "smoke.json"),
  JSON.stringify(genome),
  "utf8",
);

const result = spawnSync(
  binaryPath,
  [
    "-p",
    "Say binary ok.",
    "--genome",
    "smoke",
    "--config",
    configPath,
    "--cwd",
    runtimeDirectory,
  ],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      RSIH_CODING_AGENT_DIR: join(runtimeDirectory, ".rsih-agent"),
    },
  },
);

if (result.status !== 0) {
  throw new Error(result.stderr || `Binary exited with ${result.status}.`);
}
if (result.stdout.trim() !== "binary ok") {
  throw new Error(`Unexpected binary output: ${result.stdout.trim()}`);
}

// Sessions live wherever Pi puts them: <agentDir>/sessions/--<cwd>--/.
const canonicalCwd = realpathSync(runtimeDirectory);
const sessionDirectory = join(
  runtimeDirectory,
  ".rsih-agent",
  "sessions",
  `--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
);
const sessionFiles = readdirSync(sessionDirectory).filter((name) =>
  name.endsWith(".jsonl"),
);
if (sessionFiles.length !== 1) {
  throw new Error(`Expected one Pi session, found ${sessionFiles.length}.`);
}
const entries = readFileSync(join(sessionDirectory, sessionFiles[0]), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (
  !entries.some(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "rsih.genome" &&
      entry.data.genome_id === "harness:binary-smoke",
  )
) {
  throw new Error("Binary did not persist the Genome snapshot in the Pi session.");
}
if (
  !entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.content.some(
        (content) =>
          content.type === "text" && content.text === "binary tool ok",
      ),
  )
) {
  throw new Error("Binary did not execute the Genome Pi extension tool.");
}

console.log(`Binary smoke passed: ${binaryPath}`);
