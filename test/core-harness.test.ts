import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyHarnessPatch,
  componentOperations,
  createDefaultHarnessGenome,
  createGeneratedTools,
  createHarnessGenome,
  createHarnessPatchSchema,
  loadHarnessGenomeFile,
  mergeHarnessGenomeOverrides,
  renderHarnessSystemPrompt,
  validateHarnessGenome,
  validateHarnessPatch,
} from "../src/index.ts";
import { createMcpTools } from "../src/harness/mcp.ts";

test("Genome bundle composes contracted components", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-genome-bundle-"));
  const basePath = join(directory, "base.json");
  const contractPath = join(directory, "instructions.dev.md");
  const manifestPath = join(directory, "coding.json");
  await writeFile(
    basePath,
    JSON.stringify(
      createHarnessGenome({
        genome_id: "harness:base",
        system_prompt: "Base instructions.",
      }),
    ),
    "utf8",
  );
  await writeFile(contractPath, "# instructions\nAllowed: set_system_prompt\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: "harness:bundle-test",
      base: "./base.json",
      components: [
        {
          id: "instructions",
          contract: "./instructions.dev.md",
          config: {
            system_prompt: "Bundle instructions.",
          },
        },
        {
          id: "runtime",
          contract: "./instructions.dev.md",
          config: {
            runtime: {
              max_turns: 12,
              thinking_level: "high",
            },
          },
        },
      ],
      overrides: {
        runtime: { max_turns: 7 },
      },
    }),
    "utf8",
  );

  const loaded = loadHarnessGenomeFile(manifestPath);
  assert.equal(loaded.genome.genome_id, "harness:bundle-test");
  assert.equal(loaded.genome.system_prompt, "Bundle instructions.");
  assert.equal(loaded.genome.runtime.max_turns, 7);
  assert.equal(loaded.components.length, 2);
  assert.match(loaded.components[0].documentation, /Allowed/);
});

test("Genome bundle rejects component operations outside its contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-genome-operations-"));
  const manifestPath = join(directory, "invalid.json");
  const contractPath = join(directory, "instructions.dev.md");
  await writeFile(contractPath, "# instructions\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: "harness:invalid-operations",
      components: [
        {
          id: "instructions",
          contract: "./instructions.dev.md",
          allowed_operations: ["set_model"],
          config: { system_prompt: "must be rejected" },
        },
      ],
    }),
    "utf8",
  );

  assert.throws(
    () => loadHarnessGenomeFile(manifestPath),
    /has invalid allowed_operations/,
  );
});

test("a component-scoped patch schema only offers that component's operations", () => {
  const schema = createHarnessPatchSchema(componentOperations("instructions"));
  assert.deepEqual(schema.properties.operations.items.properties.op.enum, [
    "set_system_prompt",
    "append_system_prompt",
  ]);
});

test("an allowed patch operation applies to the Genome", () => {
  const candidate = applyHarnessPatch(createHarnessGenome(), {
    hypothesis: "Improve instructions.",
    expected_effect: "Clearer coding behavior.",
    risks: [],
    operations: [{ op: "set_system_prompt", value: "Improved instructions." }],
  });
  assert.equal(candidate.system_prompt, "Improved instructions.");
});

test("a patch operation outside the selected component is rejected", () => {
  assert.throws(
    () =>
      validateHarnessPatch(
        {
          hypothesis: "Change the model.",
          expected_effect: "Use a different model.",
          risks: [],
          operations: [{ op: "set_model", value: { profile: "local" } }],
        },
        { allowedOperations: componentOperations("instructions") },
      ),
    /is not allowed for this task/,
  );
});

test("Genome bundle rejects cross-component fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-genome-contract-"));
  const contractPath = join(directory, "tools.dev.md");
  const manifestPath = join(directory, "invalid.json");
  await writeFile(contractPath, "# tools\n", "utf8");
  await writeFile(
    manifestPath,
    JSON.stringify({
      genome_schema_version: "3",
      genome_id: "harness:invalid-bundle",
      components: [
        {
          id: "tools",
          contract: "./tools.dev.md",
          config: { system_prompt: "must be rejected" },
        },
      ],
    }),
    "utf8",
  );

  assert.throws(
    () => loadHarnessGenomeFile(manifestPath),
    /cannot configure "system_prompt"/,
  );
});

test("Genome patches every public Harness configuration surface", () => {
  const parent = createHarnessGenome();
  const candidate = applyHarnessPatch(parent, {
    hypothesis: "Exercise configurable surfaces.",
    expected_effect: "The candidate carries all requested settings.",
    risks: [],
    operations: [
      {
        op: "set_system_prompt",
        value: "Configured system prompt.",
      },
      {
        op: "append_system_prompt",
        value: "Configured suffix.",
      },
      {
        op: "upsert_tool",
        name: "external",
        value: {
          enabled: false,
          description: "Injected by the host.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      {
        op: "set_tool_enabled",
        name: "external",
        value: false,
      },
      {
        op: "upsert_skill",
        name: "inspect",
        value: {
          description: "Inspect carefully.",
          content: "Read callers before editing.",
        },
      },
      {
        op: "upsert_prompt_template",
        name: "review",
        value: { content: "Review $1" },
      },
      {
        op: "upsert_generated_tool",
        name: "echo",
        value: {
          description: "Echo arguments.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          container_script: {
            entrypoint: "/bin/sh",
            script: `printf '%s' "$HARNESS_TOOL_ARGS"`,
          },
        },
      },
      {
        op: "set_compaction_policy",
        value: {
          enabled: true,
          reserveTokens: 20000,
          keepRecentTokens: 8000,
        },
      },
      {
        op: "set_tool_policy",
        value: {
          blocked_tools: ["external"],
          max_result_chars: 1000,
        },
      },
      {
        op: "set_scratchpad_policy",
        value: {
          enabled: true,
          max_entries: 8,
          max_value_chars: 500,
        },
      },
      {
        op: "set_memory_policy",
        value: { retrieve: true, top_k: 1 },
      },
      {
        op: "set_memory_entries",
        value: [{ kind: "knowledge", content: "Prefer small diffs." }],
      },
      {
        op: "set_runtime_policy",
        value: {
          tool_execution: "parallel",
          steering_mode: "all",
          follow_up_mode: "all",
          max_turns: 12,
          thinking_level: "medium",
        },
      },
      {
        op: "set_mcp_servers",
        value: [{ name: "optional", enabled: false }],
      },
      {
        op: "set_extensions",
        value: [{ source: "./extensions/example.ts", enabled: false }],
      },
      {
        op: "set_model",
        value: { profile: "local", id: "configured-model" },
      },
      {
        op: "set_model_options",
        value: {
          max_tokens: 1024,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: true },
        },
      },
      {
        op: "set_appearance",
        value: {
          themes: ["./theme.json"],
          no_themes: true,
          theme: "dark",
        },
      },
      {
        op: "set_settings",
        value: {
          compaction: { reserveTokens: 30000 },
          treeFilterMode: "no-tools",
        },
      },
      {
        op: "set_keybindings",
        value: {
          "app.session.tree": ["ctrl+t"],
        },
      },
    ],
  });

  assert.equal(candidate.system_prompt, "Configured system prompt.");
  assert.equal(candidate.append_system_prompt, "Configured suffix.");
  assert.equal(candidate.tools.find((tool) => tool.name === "external").enabled, false);
  assert.equal(candidate.skills[0].name, "inspect");
  assert.equal(candidate.prompt_templates[0].content, "Review $1");
  assert.equal(candidate.generated_tools[0].name, "echo");
  assert.equal(candidate.policies.compaction.reserveTokens, 20000);
  assert.equal(candidate.settings.treeFilterMode, "no-tools");
  assert.deepEqual(candidate.keybindings["app.session.tree"], ["ctrl+t"]);
  assert.equal(candidate.appearance.theme, "dark");
  assert.deepEqual(candidate.policies.tool.blocked_tools, ["external"]);
  assert.equal(candidate.policies.scratchpad.enabled, true);
  assert.equal(candidate.memory.policy.retrieve, true);
  assert.equal(candidate.memory.snapshot.entries[0].content, "Prefer small diffs.");
  assert.equal(candidate.runtime.tool_execution, "parallel");
  assert.equal(candidate.mcp.servers[0].enabled, false);
  assert.equal(candidate.extensions[0].enabled, false);
  assert.equal(candidate.model.profile, "local");
  assert.equal(candidate.model.id, "configured-model");
  assert.equal(candidate.model_options.max_tokens, 1024);
  assert.deepEqual(candidate.appearance.themes, ["./theme.json"]);
  assert.equal(candidate.appearance.no_themes, true);
});

test("Genome fields are inherit-by-default", () => {
  const base = createHarnessGenome({
    genome_id: "harness:inherit-base",
    system_prompt: "Base prompt.",
    tools: [{ name: "bash", enabled: false }],
    runtime: { max_turns: 40, thinking_level: "high" },
  });

  // A component that only touches the model must not reset anything else.
  const modelOnly = mergeHarnessGenomeOverrides(base, {
    model: { profile: "openai", id: "gpt-5" },
  });
  assert.equal(modelOnly.system_prompt, "Base prompt.");
  assert.deepEqual(modelOnly.tools, [{ name: "bash", enabled: false }]);
  assert.equal(modelOnly.runtime.max_turns, 40);
  assert.equal(modelOnly.runtime.thinking_level, "high");

  // Nested objects merge instead of replacing wholesale.
  const partialRuntime = mergeHarnessGenomeOverrides(base, {
    runtime: { max_turns: 5 },
  });
  assert.equal(partialRuntime.runtime.max_turns, 5);
  assert.equal(partialRuntime.runtime.thinking_level, "high");

  // `null` is the explicit "hand this back to Pi" escape hatch.
  const reset = mergeHarnessGenomeOverrides(base, {
    system_prompt: null,
    tools: null,
  });
  assert.equal("system_prompt" in reset, false);
  assert.equal("tools" in reset, false);
  assert.equal(validateHarnessGenome(reset), reset);
});

test("the default Genome overrides nothing", () => {
  const genome = createDefaultHarnessGenome();
  assert.deepEqual(genome, {
    genome_schema_version: "2",
    genome_id: "harness:default-v0",
    parent_id: null,
    version: 1,
  });
  assert.equal(renderHarnessSystemPrompt(genome), "");
});

test("the system prompt only advertises load_skill for inline skills", () => {
  const rendered = renderHarnessSystemPrompt(
    createHarnessGenome({
      genome_id: "harness:skill-listing",
      skills: [
        { source: "./skills/review" },
        { name: "debugging", description: "Reproduce first.", content: "..." },
      ],
    }),
  );
  assert.match(rendered, /- debugging: Reproduce first\./);
  assert.doesNotMatch(rendered, /undefined/);
  assert.doesNotMatch(rendered, /review/);
});

test("Genome generated tools run as sandboxed scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-generated-tool-"));
  const genome = createHarnessGenome({
    genome_id: "harness:generated-tool-test",
    tools: [{ name: "echo_args", enabled: true }],
    generated_tools: [
      {
        name: "echo_args",
        description: "Echo the JSON tool arguments.",
        parameters: {
          type: "object",
          required: ["value"],
          additionalProperties: false,
          properties: { value: { type: "string" } },
        },
        container_script: {
          entrypoint: "/bin/sh",
          script: `printf '%s' "$HARNESS_TOOL_ARGS"`,
        },
      },
    ],
  });

  const [tool] = createGeneratedTools({ cwd: directory, genome });
  assert.equal(tool.name, "echo_args");
  assert.equal(await tool.execute({ value: "hello" }), '{"value":"hello"}');
});

test("Genome MCP servers expose real stdio tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rsih-mcp-tool-"));
  const serverPath = join(directory, "echo-server.ts");
  const url = (path) => new URL(path, import.meta.url).href;
  await writeFile(
    serverPath,
    [
      `import { Server } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"))};`,
      `import { StdioServerTransport } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};`,
      `import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(url("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"))};`,
      `const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo arguments.", inputSchema: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } } }] }));`,
      `server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }));`,
      `await server.connect(new StdioServerTransport());`,
    ].join("\n"),
    "utf8",
  );

  const mcp = await createMcpTools({
    cwd: directory,
    genome: createHarnessGenome({
      genome_id: "harness:mcp-tool-test",
      mcp: {
        servers: [
          {
            name: "local",
            command: process.execPath,
            args: ["--experimental-strip-types", serverPath],
            tools: [{ name: "echo" }],
          },
        ],
      },
    }),
  });

  try {
    const [tool] = mcp.tools;
    assert.equal(tool.name, "local_echo");
    assert.equal(await tool.execute({ value: "hello" }), '{"value":"hello"}');
  } finally {
    await mcp.close();
  }
});
