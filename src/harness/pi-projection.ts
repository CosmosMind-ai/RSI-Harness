import {
  assertPiSettingsValue,
  isGenomeOwnedSetting,
  isPiKeybindingId,
} from "./pi-surface.ts";
import { cloneJson } from "../core/json.ts";

/**
 * Semantic Genome fields that expand into Pi settings.
 *
 * Components keep domain names (`runtime.steering_mode`) and this table does the
 * translation, so component field ownership stays disjoint while a single Pi
 * setting can still be reached from whichever component owns the concept.
 */
const SETTINGS_ROUTES = Object.freeze([
  ["steeringMode", (genome) => genome.runtime?.steering_mode],
  ["followUpMode", (genome) => genome.runtime?.follow_up_mode],
  ["compaction", (genome) => genome.policies?.compaction],
  ["enabledModels", (genome) => genome.model?.cycle],
  ["theme", (genome) => genome.appearance?.theme],
]);

/** Genome fields that are routed rather than read directly by the runtime. */
export const GENOME_SETTINGS_ROUTES = Object.freeze(
  SETTINGS_ROUTES.map(([key]) => key),
);

export function assertSettingsPatch(settings) {
  if (settings === undefined) return;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("HarnessGenome.settings must be an object.");
  }
  for (const [key, value] of Object.entries(settings)) {
    if (!isGenomeOwnedSetting(key)) {
      throw new Error(
        `HarnessGenome.settings cannot configure "${key}"; see the settings component contract.`,
      );
    }
    assertPiSettingsValue(key, value, "HarnessGenome.settings");
  }
}

export function assertCompactionPolicy(compaction) {
  if (compaction === undefined) return;
  assertPiSettingsValue(
    "compaction",
    compaction,
    "HarnessGenome.policies",
  );
}

export function assertKeybindingsPatch(keybindings) {
  if (keybindings === undefined) return;
  if (
    !keybindings ||
    typeof keybindings !== "object" ||
    Array.isArray(keybindings)
  ) {
    throw new Error("HarnessGenome.keybindings must be an object.");
  }
  for (const [id, keys] of Object.entries(keybindings)) {
    if (!isPiKeybindingId(id)) {
      throw new Error(`HarnessGenome.keybindings has unknown binding id "${id}".`);
    }
    const values = Array.isArray(keys) ? keys : [keys];
    if (
      values.length === 0 ||
      values.some((key) => typeof key !== "string" || key.trim() === "")
    ) {
      throw new Error(
        `HarnessGenome.keybindings["${id}"] must be a key or a non-empty array of keys.`,
      );
    }
  }
}

/**
 * Token-budget field names across the provider APIs Pi speaks. Only keys that
 * already exist in a payload are overwritten, so a Genome can retune a request
 * without inventing a field the provider would reject.
 */
const MAX_TOKEN_KEYS = Object.freeze([
  "max_tokens",
  "max_output_tokens",
  "maxOutputTokens",
]);

export function assertModelOptions(modelOptions) {
  if (modelOptions === undefined) return;
  if (
    !modelOptions ||
    typeof modelOptions !== "object" ||
    Array.isArray(modelOptions)
  ) {
    throw new Error("HarnessGenome.model_options must be an object.");
  }
  if (
    modelOptions.extra_body !== undefined &&
    (!modelOptions.extra_body ||
      typeof modelOptions.extra_body !== "object" ||
      Array.isArray(modelOptions.extra_body))
  ) {
    throw new Error("HarnessGenome.model_options.extra_body must be an object.");
  }
}

/**
 * Apply `model_options` to a native Pi provider request. Custom RSIH providers
 * take the same values through their own stream handler; this covers the
 * anthropic/openai/google providers Pi implements itself.
 */
export function applyModelOptionsToPayload(payload, modelOptions) {
  if (!modelOptions || !payload || typeof payload !== "object") return payload;
  const next = { ...payload };

  if (modelOptions.max_tokens !== undefined) {
    for (const key of MAX_TOKEN_KEYS) {
      if (key in next) next[key] = modelOptions.max_tokens;
    }
  }
  if (modelOptions.temperature !== undefined && "temperature" in next) {
    next.temperature = modelOptions.temperature;
  }
  for (const [key, value] of Object.entries(modelOptions.extra_body ?? {})) {
    next[key] = cloneJson(value);
  }
  return next;
}

/**
 * Genome-supplied resource paths for the `resources_discover` hook.
 *
 * Pi treats the hook as additive — it extends discovery and cannot replace it —
 * so turning Pi's own discovery off is a separate, explicit decision expressed
 * by `resources.isolate` and applied through CLI flags.
 */
export function projectGenomeResources(genome, resolvePath) {
  return {
    skillPaths: genomeSourcePaths(genome.skills, resolvePath),
    promptPaths: genomeSourcePaths(genome.prompt_templates, resolvePath),
    themePaths: (genome.appearance?.themes ?? []).map(resolvePath),
  };
}

/**
 * Flags that stop Pi from auto-discovering resources. Only emitted when a
 * Genome asks for isolation, and never for context files: AGENTS.md and
 * CLAUDE.md are the repository's own instructions, not ambient resources.
 */
export function genomeResourceIsolationArgs(genome, piArgs = []) {
  if (genome.resources?.isolate !== true) return [];
  const args = [];
  for (const flag of [
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-extensions",
  ]) {
    if (!piArgs.includes(flag)) args.push(flag);
  }
  return args;
}

function genomeSourcePaths(entries, resolvePath) {
  return (entries ?? [])
    .map((entry) => (typeof entry === "string" ? { source: entry } : entry))
    .filter(
      (entry) =>
        entry?.enabled !== false &&
        typeof entry?.source === "string" &&
        entry.source.trim() !== "",
    )
    .map((entry) => resolvePath(entry.source));
}

export function assertResourcesPolicy(resources) {
  if (resources === undefined) return;
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) {
    throw new Error("HarnessGenome.resources must be an object.");
  }
  if (
    resources.isolate !== undefined &&
    typeof resources.isolate !== "boolean"
  ) {
    throw new Error("HarnessGenome.resources.isolate must be boolean.");
  }
}

/**
 * Project a resolved Genome onto the two files Pi reads from its agent
 * directory. Semantic routes expand first; the raw `settings` component is the
 * lowest-level escape hatch and therefore wins.
 */
export function projectGenomeSettings(genome) {
  const settings = {};
  for (const [key, read] of SETTINGS_ROUTES) {
    const value = read(genome);
    if (value !== undefined) settings[key] = cloneJson(value);
  }
  for (const [key, value] of Object.entries(genome.settings ?? {})) {
    settings[key] = cloneJson(value);
  }
  return {
    settings,
    keybindings: cloneJson(genome.keybindings ?? {}),
  };
}
