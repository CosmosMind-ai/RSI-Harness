import { cloneJson, contentHash } from "../core/json.ts";
import { isPiBuiltinTool } from "./pi-surface.ts";
import {
  assertCompactionPolicy,
  assertKeybindingsPatch,
  assertModelOptions,
  assertResourcesPolicy,
  assertSettingsPatch,
} from "./pi-projection.ts";

export const PROTECTED_BUILTIN_TOOL_NAMES = Object.freeze([
  "read",
  "list",
  "grep",
  "write",
  "edit",
  "bash",
  "load_skill",
  "scratchpad",
]);

export const DEFAULT_HARNESS_COMPLEXITY_LIMITS = Object.freeze({
  max_active_chars: 32000,
  max_memory_entries: 32,
  max_skills: 16,
  max_generated_tools: 8,
  max_genome_bytes: 262144,
});

const PATCH_OPERATIONS = new Set([
  "set_system_prompt",
  "append_system_prompt",
  "set_tool_enabled",
  "set_tool_description",
  "set_tool_parameters",
  "upsert_tool",
  "remove_tool",
  "upsert_skill",
  "remove_skill",
  "upsert_prompt_template",
  "remove_prompt_template",
  "upsert_generated_tool",
  "remove_generated_tool",
  "set_compaction_policy",
  "set_tool_policy",
  "set_scratchpad_policy",
  "set_memory_policy",
  "add_memory_entries",
  "set_memory_entries",
  "set_runtime_policy",
  "set_mcp_servers",
  "set_extensions",
  "set_model",
  "set_model_options",
  "set_appearance",
  "set_settings",
  "set_keybindings",
  "set_resources",
]);

export const AGENT_HARNESS_PATCH_OPERATIONS = Object.freeze([
  ...PATCH_OPERATIONS,
]);

const MEMORY_ENTRY_KINDS = new Set([
  "knowledge",
  "positive_pattern",
  "anti_pattern",
]);
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROTECTED_TOOL_SET = new Set(PROTECTED_BUILTIN_TOOL_NAMES);

const MEMORY_ENTRY_SCHEMA = {
  type: "object",
  required: ["kind", "content"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", enum: [...MEMORY_ENTRY_KINDS] },
    content: { type: "string", minLength: 1 },
  },
};

function normalizeAllowedOperations(allowedOperations) {
  const operations =
    allowedOperations === undefined
      ? [...PATCH_OPERATIONS]
      : [...new Set(allowedOperations)];
  if (operations.length === 0) {
    throw new Error("HarnessPatch requires at least one allowed operation.");
  }
  for (const operation of operations) {
    if (!PATCH_OPERATIONS.has(operation)) {
      throw new Error(`Unknown allowed HarnessPatch operation "${operation}".`);
    }
  }
  return operations;
}

export function createHarnessPatchSchema(allowedOperations) {
  const operations = normalizeAllowedOperations(allowedOperations);
  return {
    type: "object",
    required: ["hypothesis", "operations", "expected_effect", "risks"],
    additionalProperties: false,
    properties: {
      patch_id: { type: "string" },
      parent_genome_id: { type: "string" },
      evidence_refs: {
        type: "array",
        items: { type: "string" },
      },
      hypothesis: { type: "string", minLength: 1 },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["op"],
          additionalProperties: false,
          properties: {
            op: { type: "string", enum: operations },
            name: { type: "string" },
            value: {},
          },
        },
      },
      expected_effect: { type: "string", minLength: 1 },
      risks: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
      },
    },
  };
}

export const harnessPatchSchema = createHarnessPatchSchema();

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Genome fields are inherit-by-default. An absent key keeps whatever the base
 * declared, `null` drops the key so Pi's own default applies again, and any
 * other value overrides. Arrays replace wholesale; objects merge recursively.
 *
 * This is what keeps a Genome that only configures one component from silently
 * resetting every component it does not mention.
 */
export function mergeHarnessGenomeOverrides(base, overrides) {
  const result = cloneJson(base ?? {});
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue;
    if (value === null) {
      delete result[key];
      continue;
    }
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? mergeHarnessGenomeOverrides(result[key], value)
        : cloneJson(value);
  }
  return result;
}

export function createHarnessGenome(overrides = {}) {
  const base = {
    genome_schema_version: "2",
    genome_id: "harness:root",
    parent_id: null,
    version: 1,
  };
  return validateHarnessGenome(mergeHarnessGenomeOverrides(base, overrides));
}

/**
 * The default Genome overrides nothing, so running without `--genome` is
 * indistinguishable from running Pi directly.
 */
export function createDefaultHarnessGenome() {
  return createHarnessGenome({ genome_id: "harness:default-v0" });
}

function assertToolName(name, label) {
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`${label} requires a valid tool name.`);
  }
}

function validateToolSchema(parameters, label) {
  if (parameters === undefined) return;
  if (
    !parameters ||
    typeof parameters !== "object" ||
    parameters.type !== "object" ||
    !parameters.properties ||
    typeof parameters.properties !== "object"
  ) {
    throw new Error(`${label}.parameters must be an object JSON Schema.`);
  }
}

export function validateGeneratedTool(tool) {
  if (!tool || typeof tool !== "object") {
    throw new Error("Generated Harness tool must be an object.");
  }
  assertToolName(tool.name, "Generated Harness tool");
  if (PROTECTED_TOOL_SET.has(tool.name)) {
    throw new Error(`Generated tool cannot override protected tool "${tool.name}".`);
  }
  if (typeof tool.description !== "string" || tool.description.trim() === "") {
    throw new Error(`Generated tool "${tool.name}" requires a description.`);
  }
  validateToolSchema(tool.parameters, `Generated tool "${tool.name}"`);
  if (
    !tool.container_script ||
    typeof tool.container_script !== "object" ||
    typeof tool.container_script.script !== "string" ||
    tool.container_script.script.trim() === ""
  ) {
    throw new Error(
      `Generated tool "${tool.name}" requires container_script.script.`,
    );
  }
  const entrypoint = tool.container_script.entrypoint ?? "/bin/sh";
  if (!["/bin/sh", "sh"].includes(entrypoint)) {
    throw new Error(
      `Generated tool "${tool.name}" entrypoint must be POSIX sh.`,
    );
  }
  for (const [field, fallback, maximum] of [
    ["timeout_ms", 60000, 1800000],
    ["max_output_chars", 20000, 200000],
  ]) {
    const value = Number(tool[field] ?? fallback);
    if (!Number.isInteger(value) || value <= 0 || value > maximum) {
      throw new Error(
        `Generated tool "${tool.name}" ${field} must be an integer between 1 and ${maximum}.`,
      );
    }
  }
  const capabilities = tool.capabilities ?? {};
  const allowedCapabilities = new Set(["workspace", "network"]);
  for (const key of Object.keys(capabilities)) {
    if (!allowedCapabilities.has(key)) {
      throw new Error(
        `Generated tool "${tool.name}" declares unsupported capability "${key}".`,
      );
    }
  }
  if (
    capabilities.workspace !== undefined &&
    !["read", "read_write"].includes(capabilities.workspace)
  ) {
    throw new Error(
      `Generated tool "${tool.name}" has invalid workspace capability.`,
    );
  }
  if (
    capabilities.network !== undefined &&
    capabilities.network !== "task"
  ) {
    throw new Error(
      `Generated tool "${tool.name}" network capability cannot exceed the task.`,
    );
  }
  return tool;
}

function validateSkill(skill) {
  if (typeof skill === "string") return skill;
  if (!skill || typeof skill !== "object") {
    throw new Error("Harness Skill must be an object.");
  }
  if (skill.source !== undefined) {
    if (typeof skill.source !== "string" || skill.source.trim() === "") {
      throw new Error("Harness Skill source must be a non-empty string.");
    }
    if (
      skill.enabled !== undefined &&
      typeof skill.enabled !== "boolean"
    ) {
      throw new Error("Harness Skill enabled must be boolean.");
    }
    if (skill.name !== undefined) assertToolName(skill.name, "Harness Skill");
    if (
      skill.description !== undefined &&
      typeof skill.description !== "string"
    ) {
      throw new Error("Harness Skill description must be a string.");
    }
    return skill;
  }
  assertToolName(skill.name, "Harness Skill");
  for (const field of ["description", "content"]) {
    if (typeof skill[field] !== "string" || skill[field].trim() === "") {
      throw new Error(`Harness Skill "${skill.name}" requires ${field}.`);
    }
  }
  return skill;
}

function validatePromptTemplate(template) {
  if (typeof template === "string") return template;
  if (!template || typeof template !== "object") {
    throw new Error("Harness prompt template must be an object.");
  }
  // File-backed templates are loaded and registered by Pi; inline templates
  // carry their body in the Genome and become slash commands directly.
  if (template.source !== undefined) {
    if (typeof template.source !== "string" || template.source.trim() === "") {
      throw new Error("Harness prompt template source must be a non-empty string.");
    }
    if (
      template.enabled !== undefined &&
      typeof template.enabled !== "boolean"
    ) {
      throw new Error("Harness prompt template enabled must be boolean.");
    }
    return template;
  }
  assertToolName(template.name, "Harness prompt template");
  if (typeof template.content !== "string" || template.content.trim() === "") {
    throw new Error(`Harness prompt template "${template.name}" requires content.`);
  }
  if (
    template.description !== undefined &&
    typeof template.description !== "string"
  ) {
    throw new Error(`Harness prompt template "${template.name}" description must be a string.`);
  }
  return template;
}

function assertOptionalInteger(value, label, minimum, maximum) {
  if (value === undefined) return;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

export function validateHarnessGenome(genome) {
  if (!genome || typeof genome !== "object") {
    throw new Error("HarnessGenome must be an object.");
  }
  if (genome.genome_schema_version !== "2") {
    throw new Error('HarnessGenome.genome_schema_version must be "2".');
  }
  if (typeof genome.genome_id !== "string" || genome.genome_id.trim() === "") {
    throw new Error("HarnessGenome.genome_id must be a non-empty string.");
  }
  if (
    genome.parent_id !== null &&
    genome.parent_id !== undefined &&
    typeof genome.parent_id !== "string"
  ) {
    throw new Error("HarnessGenome.parent_id must be a string or null.");
  }
  assertOptionalInteger(genome.version, "HarnessGenome.version", 1, 1000000);
  for (const field of ["system_prompt", "append_system_prompt"]) {
    if (genome[field] !== undefined && typeof genome[field] !== "string") {
      throw new Error(`HarnessGenome.${field} must be a string.`);
    }
  }
  const generatedTools = genome.generated_tools ?? [];
  const toolPolicy = genome.policies?.tool ?? {};

  for (const field of ["tools", "skills", "prompt_templates", "extensions"]) {
    if (genome[field] !== undefined && !Array.isArray(genome[field])) {
      throw new Error(`HarnessGenome.${field} must be an array.`);
    }
  }
  const extensionSources = new Set();
  for (const extension of genome.extensions ?? []) {
    const source =
      typeof extension === "string" ? extension : extension?.source;
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error("HarnessGenome extensions require a source path.");
    }
    if (
      typeof extension === "object" &&
      extension.enabled !== undefined &&
      typeof extension.enabled !== "boolean"
    ) {
      throw new Error(`Harness extension "${source}" enabled must be boolean.`);
    }
    if (extensionSources.has(source)) {
      throw new Error(`Duplicate Harness extension source "${source}".`);
    }
    extensionSources.add(source);
  }
  const model = genome.model ?? {};
  if (
    model.profile !== undefined &&
    (typeof model.profile !== "string" || model.profile.trim() === "")
  ) {
    throw new Error("HarnessGenome.model.profile must be a non-empty string.");
  }
  if (
    model.id !== undefined &&
    (typeof model.id !== "string" || model.id.trim() === "")
  ) {
    throw new Error("HarnessGenome.model.id must be a non-empty string.");
  }
  if (!Array.isArray(generatedTools)) {
    throw new Error("HarnessGenome.generated_tools must be an array when provided.");
  }
  const runtime = genome.runtime ?? {};
  if (
    runtime.tool_execution !== undefined &&
    !["sequential", "parallel"].includes(runtime.tool_execution)
  ) {
    throw new Error("HarnessGenome.runtime.tool_execution is invalid.");
  }
  for (const field of ["steering_mode", "follow_up_mode"]) {
    if (
      runtime[field] !== undefined &&
      !["all", "one-at-a-time"].includes(runtime[field])
    ) {
      throw new Error(`HarnessGenome.runtime.${field} is invalid.`);
    }
  }
  assertOptionalInteger(
    runtime.max_turns,
    "Harness runtime max_turns",
    1,
    1000,
  );
  if (
    runtime.thinking_level !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh"].includes(
      runtime.thinking_level,
    )
  ) {
    throw new Error("HarnessGenome.runtime.thinking_level is invalid.");
  }
  const mcpServers = genome.mcp?.servers ?? [];
  if (!Array.isArray(mcpServers)) {
    throw new Error("HarnessGenome.mcp.servers must be an array.");
  }
  const mcpNames = new Set();
  for (const server of mcpServers) {
    if (!server || typeof server !== "object" || typeof server.name !== "string") {
      throw new Error("HarnessGenome MCP servers require a name.");
    }
    assertToolName(server.name, "Harness MCP server");
    if (mcpNames.has(server.name)) {
      throw new Error(`Duplicate Harness MCP server "${server.name}".`);
    }
    mcpNames.add(server.name);
    if (server.command !== undefined && typeof server.command !== "string") {
      throw new Error(`Harness MCP server "${server.name}" command must be a string.`);
    }
    if (server.enabled !== false && !server.command) {
      throw new Error(`Enabled Harness MCP server "${server.name}" requires command.`);
    }
    if (server.args !== undefined && !Array.isArray(server.args)) {
      throw new Error(`Harness MCP server "${server.name}" args must be an array.`);
    }
    if (
      (server.args ?? []).some((argument) => typeof argument !== "string")
    ) {
      throw new Error(`Harness MCP server "${server.name}" args must be strings.`);
    }
    if (
      server.enabled !== undefined &&
      typeof server.enabled !== "boolean"
    ) {
      throw new Error(`Harness MCP server "${server.name}" enabled must be boolean.`);
    }
    if (
      server.env !== undefined &&
      (!server.env || typeof server.env !== "object" || Array.isArray(server.env))
    ) {
      throw new Error(`Harness MCP server "${server.name}" env must be an object.`);
    }
    if (
      Object.values(server.env ?? {}).some((value) => typeof value !== "string")
    ) {
      throw new Error(`Harness MCP server "${server.name}" env values must be strings.`);
    }
    if (server.cwd !== undefined && typeof server.cwd !== "string") {
      throw new Error(`Harness MCP server "${server.name}" cwd must be a string.`);
    }
    if (server.tools !== undefined && !Array.isArray(server.tools)) {
      throw new Error(`Harness MCP server "${server.name}" tools must be an array.`);
    }
    const toolNames = new Set();
    for (const tool of server.tools ?? []) {
      if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
        throw new Error(`Harness MCP server "${server.name}" tools require a name.`);
      }
      if (toolNames.has(tool.name)) {
        throw new Error(
          `Harness MCP server "${server.name}" has duplicate tool "${tool.name}".`,
        );
      }
      toolNames.add(tool.name);
      if (
        tool.enabled !== undefined &&
        typeof tool.enabled !== "boolean"
      ) {
        throw new Error(
          `Harness MCP tool "${server.name}.${tool.name}" enabled must be boolean.`,
        );
      }
      if (
        tool.description !== undefined &&
        typeof tool.description !== "string"
      ) {
        throw new Error(
          `Harness MCP tool "${server.name}.${tool.name}" description must be a string.`,
        );
      }
      if (tool.expose_as !== undefined) {
        assertToolName(tool.expose_as, `Harness MCP tool "${tool.name}"`);
      }
      validateToolSchema(
        tool.parameters,
        `Harness MCP tool "${server.name}.${tool.name}"`,
      );
    }
  }

  const names = new Set();
  for (const tool of genome.tools ?? []) {
    assertToolName(tool?.name, "Every HarnessGenome tool");
    if (names.has(tool.name)) {
      throw new Error(`Duplicate HarnessGenome tool "${tool.name}".`);
    }
    if (tool.enabled !== undefined && typeof tool.enabled !== "boolean") {
      throw new Error(`Harness tool "${tool.name}" enabled must be boolean.`);
    }
    if (tool.description !== undefined) {
      if (typeof tool.description !== "string") {
        throw new Error(`Harness tool "${tool.name}" description must be a string.`);
      }
      if (isPiBuiltinTool(tool.name)) {
        throw new Error(
          `Harness tool "${tool.name}" is implemented by Pi; its description cannot be replaced. Narrow "parameters" instead, or override the tool from an extension.`,
        );
      }
    }
    validateToolSchema(tool.parameters, `Harness tool "${tool.name}"`);
    names.add(tool.name);
  }
  const generatedNames = new Set();
  for (const tool of generatedTools) {
    validateGeneratedTool(tool);
    if (generatedNames.has(tool.name)) {
      throw new Error(`Duplicate generated Harness tool "${tool.name}".`);
    }
    generatedNames.add(tool.name);
    if (!names.has(tool.name)) {
      throw new Error(
        `Generated Harness tool "${tool.name}" requires a matching tools declaration.`,
      );
    }
  }
  const skillNames = new Set();
  for (const skill of genome.skills ?? []) {
    validateSkill(skill);
    if (typeof skill === "string" || skill.source !== undefined) continue;
    if (skillNames.has(skill.name)) {
      throw new Error(`Duplicate Harness Skill "${skill.name}".`);
    }
    skillNames.add(skill.name);
  }
  const templateNames = new Set();
  for (const template of genome.prompt_templates ?? []) {
    validatePromptTemplate(template);
    if (typeof template === "string" || template.source !== undefined) continue;
    if (templateNames.has(template.name)) {
      throw new Error(`Duplicate Harness prompt template "${template.name}".`);
    }
    templateNames.add(template.name);
  }

  assertCompactionPolicy(genome.policies?.compaction);
  assertOptionalInteger(
    toolPolicy.max_result_chars,
    "Harness tool max_result_chars",
    1,
    200000,
  );
  const scratchpadPolicy = genome.policies?.scratchpad ?? {};
  if (
    scratchpadPolicy.enabled !== undefined &&
    typeof scratchpadPolicy.enabled !== "boolean"
  ) {
    throw new Error("Harness scratchpad enabled must be boolean.");
  }
  assertOptionalInteger(
    scratchpadPolicy.max_entries,
    "Harness scratchpad max_entries",
    1,
    128,
  );
  assertOptionalInteger(
    scratchpadPolicy.max_value_chars,
    "Harness scratchpad max_value_chars",
    1,
    20000,
  );
  if (!Array.isArray(toolPolicy.blocked_tools ?? [])) {
    throw new Error("HarnessGenome.policies.tool.blocked_tools must be an array.");
  }
  for (const name of toolPolicy.blocked_tools ?? []) {
    assertToolName(name, "Harness blocked tool");
  }
  if (
    genome.memory?.snapshot !== undefined &&
    !Array.isArray(genome.memory.snapshot.entries)
  ) {
    throw new Error("HarnessGenome.memory.snapshot.entries must be an array.");
  }
  const memoryPolicy = genome.memory?.policy ?? {};
  if (
    memoryPolicy.retrieve !== undefined &&
    typeof memoryPolicy.retrieve !== "boolean"
  ) {
    throw new Error("Harness memory retrieve must be boolean.");
  }
  assertOptionalInteger(
    memoryPolicy.top_k,
    "Harness memory top_k",
    0,
    1000,
  );
  const modelOptions = genome.model_options ?? {};
  assertOptionalInteger(
    modelOptions.max_tokens,
    "Harness model_options.max_tokens",
    1,
    1000000,
  );
  if (
    modelOptions.temperature !== undefined &&
    (!Number.isFinite(Number(modelOptions.temperature)) ||
      Number(modelOptions.temperature) < 0 ||
      Number(modelOptions.temperature) > 2)
  ) {
    throw new Error("Harness model_options.temperature must be between 0 and 2.");
  }
  if (
    modelOptions.chat_template_kwargs !== undefined &&
    (!modelOptions.chat_template_kwargs ||
      typeof modelOptions.chat_template_kwargs !== "object" ||
      Array.isArray(modelOptions.chat_template_kwargs))
  ) {
    throw new Error(
      "Harness model_options.chat_template_kwargs must be an object.",
    );
  }
  const appearance = genome.appearance ?? {};
  if (appearance.themes !== undefined && !Array.isArray(appearance.themes)) {
    throw new Error("HarnessGenome.appearance.themes must be an array.");
  }
  if (
    (appearance.themes ?? []).some(
      (theme) => typeof theme !== "string" || theme.trim() === "",
    )
  ) {
    throw new Error("HarnessGenome.appearance.themes must contain non-empty strings.");
  }
  if (
    appearance.theme !== undefined &&
    (typeof appearance.theme !== "string" || appearance.theme.trim() === "")
  ) {
    throw new Error("HarnessGenome.appearance.theme must be a non-empty string.");
  }
  if (
    appearance.no_themes !== undefined &&
    typeof appearance.no_themes !== "boolean"
  ) {
    throw new Error("HarnessGenome.appearance.no_themes must be boolean.");
  }
  validateMemoryEntries(
    genome.memory?.snapshot?.entries ?? [],
    "genome memory",
  );
  assertModelOptions(genome.model_options);
  assertResourcesPolicy(genome.resources);
  assertSettingsPatch(genome.settings);
  assertKeybindingsPatch(genome.keybindings);
  return genome;
}

function findNamed(items, name) {
  return items.findIndex((item) => item.name === name);
}

function requireName(operation) {
  if (!operation.name) {
    throw new Error(`Patch operation "${operation.op}" requires "name".`);
  }
}

function validateMemoryEntries(value, operation = "set_memory_entries") {
  if (!Array.isArray(value)) {
    throw new Error(
      `HarnessPatch operation "${operation}" requires an array value.`,
    );
  }
  for (const [index, entry] of value.entries()) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.content !== "string" ||
      entry.content.trim().length === 0
    ) {
      throw new Error(`Harness memory entry ${index} requires non-empty content.`);
    }
    if (entry.kind === undefined) entry.kind = "knowledge";
    if (!MEMORY_ENTRY_KINDS.has(entry.kind)) {
      throw new Error(
        `Harness memory entry ${index} requires kind "knowledge", "positive_pattern", or "anti_pattern".`,
      );
    }
  }
  return value;
}

export function validateHarnessPatch(patch, { allowedOperations } = {}) {
  if (!patch || typeof patch !== "object" || !Array.isArray(patch.operations)) {
    throw new Error("HarnessPatch requires an operations array.");
  }
  for (const field of ["hypothesis", "expected_effect"]) {
    if (typeof patch[field] !== "string" || patch[field].trim() === "") {
      throw new Error(`HarnessPatch requires non-empty ${field}.`);
    }
  }
  if (!Array.isArray(patch.risks)) {
    throw new Error("HarnessPatch requires a risks array.");
  }
  if (patch.operations.length < 1 || patch.operations.length > 20) {
    throw new Error("HarnessPatch operations must contain 1-20 items.");
  }
  const allowed = new Set(normalizeAllowedOperations(allowedOperations));
  for (const operation of patch.operations) {
    if (!PATCH_OPERATIONS.has(operation.op)) {
      throw new Error(`Unsupported HarnessPatch operation "${operation.op}".`);
    }
    if (!allowed.has(operation.op)) {
      throw new Error(
        `HarnessPatch operation "${operation.op}" is not allowed for this task.`,
      );
    }
    if (
      [
        "set_tool_enabled",
        "set_tool_description",
        "set_tool_parameters",
        "upsert_tool",
        "remove_tool",
        "upsert_skill",
        "remove_skill",
        "upsert_prompt_template",
        "remove_prompt_template",
        "upsert_generated_tool",
        "remove_generated_tool",
      ].includes(operation.op)
    ) {
      requireName(operation);
    }
    if (["set_memory_entries", "add_memory_entries"].includes(operation.op)) {
      validateMemoryEntries(operation.value, operation.op);
    }
    if (operation.op === "upsert_generated_tool") {
      validateGeneratedTool({ ...operation.value, name: operation.name });
    }
  }
  return patch;
}

function schemaEnumNarrows(parent, candidate) {
  if (!parent?.enum) return true;
  if (!candidate?.enum) return false;
  return candidate.enum.every((value) => parent.enum.includes(value));
}

export function isCompatibleToolSchema(parent, candidate) {
  if (!parent || !candidate || parent.type !== "object" || candidate.type !== "object") {
    return false;
  }
  if (parent.additionalProperties === false && candidate.additionalProperties !== false) {
    return false;
  }
  const parentProperties = parent.properties ?? {};
  const candidateProperties = candidate.properties ?? {};
  for (const [name, schema] of Object.entries(candidateProperties)) {
    const original = parentProperties[name];
    if (!original || original.type !== schema.type || !schemaEnumNarrows(original, schema)) {
      return false;
    }
    if (
      original.minimum !== undefined &&
      Number(schema.minimum ?? -Infinity) < original.minimum
    ) {
      return false;
    }
    if (
      original.maximum !== undefined &&
      Number(schema.maximum ?? Infinity) > original.maximum
    ) {
      return false;
    }
  }
  const required = new Set(candidate.required ?? []);
  return (parent.required ?? []).every((name) => required.has(name));
}

export function applyHarnessPatch(parent, patch) {
  validateHarnessGenome(parent);
  validateHarnessPatch(patch);
  const next = cloneJson(parent);
  // Genomes are inherit-by-default, so a patch may be the first thing to
  // populate a collection. Materialize the containers the operations mutate.
  next.tools ??= [];
  next.generated_tools ??= [];
  next.skills ??= [];
  next.prompt_templates ??= [];
  next.policies ??= {};
  next.memory ??= {};
  next.memory.snapshot ??= { entries: [] };
  next.memory.snapshot.entries ??= [];

  for (const operation of patch.operations) {
    switch (operation.op) {
      case "set_system_prompt":
        next.system_prompt = String(operation.value ?? "");
        break;
      case "append_system_prompt":
        next.append_system_prompt = String(operation.value ?? "");
        break;
      case "set_tool_enabled": {
        const index = findNamed(next.tools, operation.name);
        if (index < 0) throw new Error(`Unknown Harness tool "${operation.name}".`);
        next.tools[index].enabled = Boolean(operation.value);
        break;
      }
      case "set_tool_description": {
        const index = findNamed(next.tools, operation.name);
        if (index < 0) throw new Error(`Unknown Harness tool "${operation.name}".`);
        next.tools[index].description = String(operation.value ?? "");
        break;
      }
      case "set_tool_parameters": {
        const index = findNamed(next.tools, operation.name);
        if (index < 0) throw new Error(`Unknown Harness tool "${operation.name}".`);
        next.tools[index].parameters = cloneJson(operation.value ?? {});
        break;
      }
      case "upsert_tool": {
        const tool = {
          name: operation.name,
          enabled: operation.value?.enabled !== false,
          ...(operation.value?.description === undefined
            ? {}
            : { description: String(operation.value.description) }),
          ...(operation.value?.parameters === undefined
            ? {}
            : { parameters: cloneJson(operation.value.parameters) }),
        };
        const index = findNamed(next.tools, operation.name);
        if (index < 0) next.tools.push(tool);
        else next.tools[index] = tool;
        break;
      }
      case "remove_tool":
        if (PROTECTED_TOOL_SET.has(operation.name)) {
          throw new Error(
            `Protected Harness tool "${operation.name}" can be disabled but not removed.`,
          );
        }
        next.tools = next.tools.filter((tool) => tool.name !== operation.name);
        next.generated_tools = next.generated_tools.filter(
          (tool) => tool.name !== operation.name,
        );
        break;
      case "upsert_skill": {
        const skillBody = {
          name: operation.name,
          description: String(operation.value?.description ?? ""),
          content: String(operation.value?.content ?? ""),
        };
        const skillHash = contentHash(skillBody);
        const skill = {
          ...skillBody,
          component_id: `skill:${skillHash.slice(0, 16)}`,
          content_hash: skillHash,
        };
        validateSkill(skill);
        const index = findNamed(next.skills, operation.name);
        if (index < 0) next.skills.push(skill);
        else next.skills[index] = skill;
        break;
      }
      case "remove_skill":
        next.skills = next.skills.filter((skill) => skill.name !== operation.name);
        break;
      case "upsert_prompt_template": {
        const template = {
          name: operation.name,
          description: String(operation.value?.description ?? ""),
          content: String(operation.value?.content ?? ""),
        };
        validatePromptTemplate(template);
        const index = findNamed(next.prompt_templates, operation.name);
        if (index < 0) next.prompt_templates.push(template);
        else next.prompt_templates[index] = template;
        break;
      }
      case "remove_prompt_template":
        next.prompt_templates = next.prompt_templates.filter(
          (template) => template.name !== operation.name,
        );
        break;
      case "upsert_generated_tool": {
        const toolBody = {
          ...cloneJson(operation.value ?? {}),
          name: operation.name,
        };
        const toolHash = contentHash(toolBody);
        const tool = {
          ...toolBody,
          component_id: `tool:${toolHash.slice(0, 16)}`,
          content_hash: toolHash,
        };
        validateGeneratedTool(tool);
        const index = findNamed(next.generated_tools, operation.name);
        if (index < 0) next.generated_tools.push(tool);
        else next.generated_tools[index] = tool;
        const declaration = findNamed(next.tools, operation.name);
        if (declaration < 0) {
          next.tools.push({
            name: operation.name,
            enabled: tool.enabled !== false,
          });
        } else {
          next.tools[declaration].enabled = tool.enabled !== false;
        }
        break;
      }
      case "remove_generated_tool":
        next.generated_tools = next.generated_tools.filter(
          (tool) => tool.name !== operation.name,
        );
        next.tools = next.tools.filter((tool) => tool.name !== operation.name);
        break;
      case "set_compaction_policy":
        next.policies.compaction = cloneJson(operation.value ?? {});
        break;
      case "set_tool_policy":
        next.policies.tool = cloneJson(operation.value ?? {});
        break;
      case "set_scratchpad_policy":
        next.policies.scratchpad = cloneJson(operation.value ?? {});
        break;
      case "set_memory_policy":
        next.memory.policy = cloneJson(operation.value ?? {});
        break;
      case "set_memory_entries":
        next.memory.snapshot.entries = cloneJson(
          validateMemoryEntries(operation.value, operation.op),
        );
        break;
      case "add_memory_entries":
        next.memory.snapshot.entries.push(
          ...cloneJson(validateMemoryEntries(operation.value, operation.op)),
        );
        break;
      case "set_runtime_policy":
        next.runtime = cloneJson(operation.value ?? {});
        break;
      case "set_mcp_servers":
        next.mcp = { servers: cloneJson(operation.value ?? []) };
        break;
      case "set_extensions":
        next.extensions = cloneJson(operation.value ?? []);
        break;
      case "set_model":
        next.model = cloneJson(operation.value ?? {});
        break;
      case "set_model_options":
        next.model_options = cloneJson(operation.value ?? {});
        break;
      case "set_appearance":
        next.appearance = cloneJson(operation.value ?? {});
        break;
      case "set_settings":
        next.settings = cloneJson(operation.value ?? {});
        break;
      case "set_keybindings":
        next.keybindings = cloneJson(operation.value ?? {});
        break;
      case "set_resources":
        next.resources = cloneJson(operation.value ?? {});
        break;
      default:
        throw new Error(`Unhandled HarnessPatch operation "${operation.op}".`);
    }
  }

  next.parent_id = parent.genome_id;
  next.version = Number(parent.version ?? 0) + 1;
  next.genome_schema_version = "2";
  next.genome_id = `harness:${contentHash({
    parent: next.parent_id,
    patch,
  }).slice(0, 16)}`;
  return validateHarnessGenome(next);
}

function activeHarnessText(genome) {
  return [
    genome.system_prompt ?? "",
    genome.append_system_prompt ?? "",
    ...(genome.memory?.snapshot?.entries ?? []).map((entry) => entry.content),
    ...(genome.skills ?? []).flatMap((skill) =>
      typeof skill === "string"
        ? [skill]
        : [skill.name ?? "", skill.description ?? "", skill.content ?? "", skill.source ?? ""],
    ),
    ...(genome.tools ?? []).flatMap((tool) => [
      tool.name,
      tool.description ?? "",
      JSON.stringify(tool.parameters ?? {}),
    ]),
  ].join("\n");
}

export function measureHarnessComplexity(genome) {
  validateHarnessGenome(genome);
  return {
    active_chars: activeHarnessText(genome).length,
    memory_entries: (genome.memory?.snapshot?.entries ?? []).length,
    skills: (genome.skills ?? []).length,
    generated_tools: (genome.generated_tools ?? []).length,
    genome_bytes: Buffer.byteLength(JSON.stringify(genome), "utf8"),
  };
}

export function assertHarnessComplexity(
  genome,
  limits = DEFAULT_HARNESS_COMPLEXITY_LIMITS,
) {
  const resolved = { ...DEFAULT_HARNESS_COMPLEXITY_LIMITS, ...limits };
  const measured = measureHarnessComplexity(genome);
  const checks = [
    ["active_chars", "max_active_chars"],
    ["memory_entries", "max_memory_entries"],
    ["skills", "max_skills"],
    ["generated_tools", "max_generated_tools"],
    ["genome_bytes", "max_genome_bytes"],
  ];
  for (const [metric, limit] of checks) {
    if (measured[metric] > Number(resolved[limit])) {
      throw new Error(
        `Harness Genome complexity ${metric}=${measured[metric]} exceeds ${limit}=${resolved[limit]}.`,
      );
    }
  }
  return measured;
}

export function renderHarnessSystemPrompt(genome) {
  const parts = [genome.system_prompt, genome.append_system_prompt];
  const memory = genome.memory?.snapshot?.entries ?? [];
  if (genome.memory?.policy?.retrieve && memory.length > 0) {
    const topK = Math.max(0, Number(genome.memory.policy.top_k ?? 0));
    const selected = topK > 0 ? memory.slice(0, topK) : memory;
    parts.push(
      [
        "Persistent memory:",
        ...selected.map((entry) => {
          const label =
            entry?.kind === "knowledge"
              ? "knowledge"
              : entry?.kind === "positive_pattern"
                ? "positive pattern"
                : entry?.kind === "anti_pattern"
                  ? "anti-pattern"
                  : "memory";
          return `- [${label}] ${entry?.content ?? String(entry)}`;
        }),
      ].join("\n"),
    );
  }
  // Only inline skills are reachable through load_skill. File-backed skills are
  // discovered and announced by Pi itself, so listing them here would advertise
  // a name that load_skill cannot resolve.
  const inlineSkills = (genome.skills ?? []).filter(
    (skill) =>
      skill && typeof skill === "object" && skill.source === undefined,
  );
  if (inlineSkills.length > 0) {
    parts.push(
      [
        "Available skills (load only when relevant with load_skill):",
        ...inlineSkills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
    );
  }
  const inlineTemplates = (genome.prompt_templates ?? []).filter(
    (template) =>
      template && typeof template === "object" && template.source === undefined,
  );
  if (inlineTemplates.length > 0) {
    parts.push(
      [
        "Available prompt templates:",
        ...inlineTemplates.map(
          (template) => `- ${template.name}: ${template.description ?? ""}`,
        ),
      ].join("\n"),
    );
  }
  if ((genome.mcp?.servers ?? []).length > 0) {
    parts.push(
      [
        "Configured MCP servers:",
        ...(genome.mcp.servers ?? []).map(
          (server) => `- ${server.name}${server.enabled === false ? " (disabled)" : ""}`,
        ),
      ].join("\n"),
    );
  }
  const narrowed = (genome.tools ?? []).filter(
    (tool) => tool.enabled !== false && tool.parameters,
  );
  if (narrowed.length > 0) {
    parts.push(
      [
        "Tool parameter contracts (calls outside these are rejected):",
        ...narrowed.map(
          (tool) => `- ${tool.name}: ${JSON.stringify(tool.parameters)}`,
        ),
      ].join("\n"),
    );
  }
  if (genome.policies?.scratchpad?.enabled) {
    parts.push(
      "A session-only scratchpad tool is available for durable state within this task. It is cleared after the task and never updates persistent memory.",
    );
  }
  return parts.filter(Boolean).join("\n\n");
}
