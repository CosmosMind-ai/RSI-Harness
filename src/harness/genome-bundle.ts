import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cloneJson } from "../core/json.ts";
import {
  AGENT_HARNESS_PATCH_OPERATIONS,
  createDefaultHarnessGenome,
  mergeHarnessGenomeOverrides,
  validateHarnessGenome,
} from "./genome.ts";

export const HARNESS_COMPONENT_IDS = Object.freeze([
  "instructions",
  "tools",
  "skills",
  "commands",
  "model",
  "runtime",
  "policies",
  "integrations",
  "appearance",
  "settings",
  "keybindings",
  "resources",
]);

const COMPONENT_FIELDS = Object.freeze({
  instructions: ["system_prompt", "append_system_prompt"],
  tools: ["tools", "generated_tools"],
  skills: ["skills"],
  commands: ["prompt_templates"],
  model: ["model", "model_options"],
  runtime: ["runtime"],
  policies: ["policies", "memory"],
  integrations: ["extensions", "mcp"],
  appearance: ["appearance"],
  settings: ["settings"],
  keybindings: ["keybindings"],
  resources: ["resources"],
});

const COMPONENT_OPERATIONS = Object.freeze({
  instructions: ["set_system_prompt", "append_system_prompt"],
  tools: [
    "set_tool_enabled",
    "set_tool_description",
    "set_tool_parameters",
    "upsert_tool",
    "remove_tool",
    "upsert_generated_tool",
    "remove_generated_tool",
  ],
  skills: ["upsert_skill", "remove_skill"],
  commands: ["upsert_prompt_template", "remove_prompt_template"],
  model: ["set_model", "set_model_options"],
  runtime: ["set_runtime_policy"],
  policies: [
    "set_compaction_policy",
    "set_tool_policy",
    "set_scratchpad_policy",
    "set_memory_policy",
    "add_memory_entries",
    "set_memory_entries",
  ],
  integrations: ["set_extensions", "set_mcp_servers"],
  appearance: ["set_appearance"],
  settings: ["set_settings"],
  keybindings: ["set_keybindings"],
  resources: ["set_resources"],
});

const PATCH_OPERATION_SET = new Set(AGENT_HARNESS_PATCH_OPERATIONS);

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
}

function assertComponentId(id) {
  if (!HARNESS_COMPONENT_IDS.includes(id)) {
    throw new Error(
      `Unknown Harness Genome component "${id}". Expected one of ${HARNESS_COMPONENT_IDS.join(", ")}.`,
    );
  }
}

function resolveRequiredPath(baseDirectory, value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} requires a non-empty path.`);
  }
  const path = resolve(baseDirectory, value);
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }
  return path;
}

function componentConfig(value, id, sourcePath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Genome component "${id}" must contain an object config: ${sourcePath}`);
  }
  const config =
    value.config && typeof value.config === "object" && !Array.isArray(value.config)
      ? value.config
      : value;
  const allowedFields = new Set(COMPONENT_FIELDS[id]);
  const metadata = new Set([
    "component_schema_version",
    "component_id",
    "config",
    "contract",
    "source",
    "allowed_operations",
  ]);
  for (const field of Object.keys(config)) {
    if (!allowedFields.has(field) && !metadata.has(field)) {
      throw new Error(
        `Genome component "${id}" cannot configure "${field}"; see its contract.`,
      );
    }
  }
  const result = cloneJson(config);
  for (const field of metadata) delete result[field];
  return result;
}

function componentDescriptor(raw, baseDirectory, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Genome component ${index} must be an object.`);
  }
  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`Genome component ${index} requires an id.`);
  }
  assertComponentId(id);
  const contract = resolveRequiredPath(
    baseDirectory,
    raw.contract,
    `Genome component "${id}" contract`,
  );
  const source =
    raw.source === undefined
      ? undefined
      : resolveRequiredPath(baseDirectory, raw.source, `Genome component "${id}" source`);
  const allowedOperations = raw.allowed_operations
    ? [...new Set(raw.allowed_operations)]
    : [...COMPONENT_OPERATIONS[id]];
  if (
    !Array.isArray(allowedOperations) ||
    allowedOperations.length === 0 ||
    allowedOperations.some(
      (operation) =>
        typeof operation !== "string" ||
        !PATCH_OPERATION_SET.has(operation) ||
        !COMPONENT_OPERATIONS[id].includes(operation),
    )
  ) {
    throw new Error(
      `Genome component "${id}" has invalid allowed_operations; see its contract.`,
    );
  }
  if (source === undefined && raw.config === undefined) {
    throw new Error(`Genome component "${id}" requires source or config.`);
  }
  return {
    id,
    source,
    contract,
    allowed_operations: allowedOperations,
    documentation: readFileSync(contract, "utf8"),
    raw,
  };
}

function loadGenomeDocument(path, stack) {
  const absolutePath = resolve(path);
  if (stack.includes(absolutePath)) {
    throw new Error(`Circular Harness Genome bundle reference: ${[...stack, absolutePath].join(" -> ")}`);
  }
  const value = readJson(absolutePath, "Harness Genome");
  if (value?.genome_schema_version !== "3") {
    return {
      genome: validateHarnessGenome(value),
      components: [],
      baseDirectory: dirname(absolutePath),
      manifestPath: absolutePath,
    };
  }
  if (!Array.isArray(value.components)) {
    throw new Error("Harness Genome bundle requires a components array.");
  }
  if (typeof value.genome_id !== "string" || value.genome_id.trim() === "") {
    throw new Error("Harness Genome bundle requires a non-empty genome_id.");
  }

  const baseReference = value.base ?? "default";
  const base =
    baseReference === "default"
      ? {
          genome: createDefaultHarnessGenome(),
          components: [],
          baseDirectory: dirname(absolutePath),
        }
      : loadGenomeDocument(
          resolve(dirname(absolutePath), baseReference),
          [...stack, absolutePath],
        );
  const ids = new Set();
  let genome = base.genome;
  const components = [...base.components];
  const manifestComponents = [];

  for (const [index, rawComponent] of value.components.entries()) {
    const descriptor = componentDescriptor(rawComponent, dirname(absolutePath), index);
    if (ids.has(descriptor.id)) {
      throw new Error(`Genome bundle contains duplicate component "${descriptor.id}".`);
    }
    ids.add(descriptor.id);
    const sourceValue =
      descriptor.source === undefined
        ? descriptor.raw
        : readJson(descriptor.source, `Genome component "${descriptor.id}"`);
    genome = mergeHarnessGenomeOverrides(
      genome,
      componentConfig(sourceValue, descriptor.id, descriptor.source ?? absolutePath),
    );
    components.push({
      id: descriptor.id,
      source: descriptor.source,
      contract: descriptor.contract,
      allowed_operations: descriptor.allowed_operations,
      documentation: descriptor.documentation,
    });
    manifestComponents.push({
      id: descriptor.id,
      source: rawComponent.source,
      contract: rawComponent.contract,
      allowed_operations: descriptor.allowed_operations,
    });
  }

  genome = mergeHarnessGenomeOverrides(genome, value.overrides ?? {});
  genome.genome_schema_version = "2";
  genome.genome_id = value.genome_id;
  genome.parent_id = value.parent_id ?? base.genome.genome_id;
  genome.version = value.version ?? 1;
  genome.component_manifest = {
    schema_version: "1",
    source: absolutePath,
    base: baseReference,
    components: manifestComponents,
  };

  return {
    genome: validateHarnessGenome(genome),
    components,
    baseDirectory: dirname(absolutePath),
    manifestPath: absolutePath,
  };
}

export function isHarnessGenomeBundle(value) {
  return value?.genome_schema_version === "3";
}

export function loadHarnessGenomeFile(path) {
  return loadGenomeDocument(path, []);
}

export function componentOperations(componentId) {
  assertComponentId(componentId);
  return [...COMPONENT_OPERATIONS[componentId]];
}
