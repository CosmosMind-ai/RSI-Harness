import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  createAssistantMessageEventStream,
  Type,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import {
  getAgentDir as getPiAgentDir,
  main as runPiMain,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { loadEnvFile, loadProviderProfiles, resolveProviderProfile } from "./model/env.ts";
import { ModelRuntime } from "./model/model-runtime.ts";
import { createGeneratedTools } from "./harness/builtin-tools.ts";
import {
  createRsiEditor,
  createRsiHeader,
} from "./tui/rsih-tui.ts";
import {
  renderHarnessSystemPrompt,
} from "./harness/genome.ts";
import {
  availableGenomeNames,
  resolveHarnessGenome,
  genomeDisplayName,
} from "./harness/genome-loader.ts";
import {
  createGenomeSession,
  startupPromptRecord,
  switchedSystemPrompt,
  unswitchableDifferences,
} from "./harness/genome-session.ts";
import { validateJsonSchema } from "./core/schema.ts";
import { createMcpTools } from "./harness/mcp.ts";
import {
  applyModelOptionsToPayload,
  genomeResourceIsolationArgs,
  projectGenomeResources,
  projectGenomeSettings,
} from "./harness/pi-projection.ts";
import { applyManagedConfiguration } from "./harness/settings-layer.ts";
import { runGenomeCommand } from "./cli/genome-command.ts";
import {
  SUPERVISED_ENV,
  SWITCHED_FROM_ENV,
  writeSwitchRequest,
} from "./cli/supervisor.ts";

/** Kept in sync with package.json; shown in the header and settings stamp. */
export const RSIH_VERSION = "0.1.0";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const CUSTOM_OPTIONS = new Set([
  "--genome",
  "--profile",
  "--config",
  "--env",
  "--cwd",
  "--max-turns",
  "--run-id",
]);

const RSIH_FLAG_DESCRIPTIONS = Object.freeze([
  ["profile", "Provider profile from --config (also sets Pi's --provider)."],
  ["config", "Provider profile JSON with custom model endpoints."],
  ["env", "Env file to load before starting (default: ./.env)."],
  ["cwd", "Working directory to run in."],
  ["max-turns", "Abort the agent after this many turns."],
  ["run-id", "Session id to create or reuse (Pi's --session-id)."],
]);

/**
 * Settings RSIH itself needs regardless of Genome. RSIH draws its own header,
 * so Pi's startup resource listing would be printed twice; `quietStartup`
 * suppresses the listing without disabling any resource.
 */
const RSIH_BASE_SETTINGS = Object.freeze({ quietStartup: true });

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseCliArgs(argv) {
  const result = {
    cwd: ".",
    maxTurns: undefined,
    json: false,
    newSession: false,
    piArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // Pi accepts both `--option value` and `--option=value`. RSIH consumes its
    // own options before Pi parses argv, so it has to understand both
    // spellings — otherwise `--genome=paperlab` falls through to Pi untouched and
    // silently starts the default Genome.
    const equals = argument.indexOf("=");
    const option = equals === -1 ? argument : argument.slice(0, equals);
    if (CUSTOM_OPTIONS.has(option)) {
      let value;
      if (equals === -1) {
        value = requireValue(argv, index, option);
        index += 1;
      } else {
        value = argument.slice(equals + 1);
        if (value === "") throw new Error(`${option} requires a value.`);
      }
      switch (option) {
        case "--genome":
          result.genome = value;
          break;
        case "--profile":
          result.profile = value;
          result.piArgs.push("--provider", value);
          break;
        case "--config":
          result.config = value;
          break;
        case "--env":
          result.env = value;
          break;
        case "--cwd":
          result.cwd = value;
          break;
        case "--max-turns": {
          const maxTurns = Number(value);
          if (!Number.isInteger(maxTurns) || maxTurns < 1) {
            throw new Error("--max-turns must be a positive integer.");
          }
          result.maxTurns = maxTurns;
          break;
        }
        case "--run-id":
          result.piArgs.push("--session-id", value);
          break;
      }
      continue;
    }
    if (argument === "--json") {
      result.json = true;
      result.piArgs.push("--mode", "json");
      continue;
    }
    if (argument === "--new") {
      result.newSession = true;
      continue;
    }
    result.piArgs.push(argument);
  }

  return result;
}

function optionValue(args, name) {
  const equalsPrefix = `${name}=`;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (args[index].startsWith(equalsPrefix)) {
      return args[index].slice(equalsPrefix.length);
    }
    if (args[index] === name) return args[index + 1];
  }
  return undefined;
}

function hasOption(args, ...names) {
  return args.some((argument) =>
    names.some((name) => argument === name || argument.startsWith(`${name}=`)),
  );
}

/**
 * Theme selection and the theme-discovery switch are CLI-level; the theme
 * *paths* a Genome ships are supplied through `resources_discover` instead.
 */
export function genomeAppearanceArgs(genome, piArgs = []) {
  const args = [];
  if (
    genome.appearance?.theme &&
    !hasOption(piArgs, "--use-theme")
  ) {
    args.push("--use-theme", genome.appearance.theme);
  }
  if (genome.appearance?.no_themes && !hasOption(piArgs, "--no-themes")) {
    args.push("--no-themes");
  }
  return args;
}

function sourceEntry(entry) {
  if (typeof entry === "string") return { source: entry, enabled: true };
  return { ...entry, enabled: entry.enabled !== false };
}

function resolveGenomeSources(entries, baseDirectory) {
  return (entries ?? [])
    .map(sourceEntry)
    .filter(
      (entry) =>
        entry.enabled &&
        typeof entry.source === "string" &&
        entry.source.trim() !== "",
    )
    .map((entry) => resolve(baseDirectory, entry.source));
}

function sessionFiles(sessionDirectory) {
  try {
    return readdirSync(sessionDirectory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(sessionDirectory, name));
  } catch {
    return [];
  }
}

function readSessionEntries(path) {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function sessionId(path) {
  return readSessionEntries(path).find((entry) => entry.type === "session")?.id;
}

function findSessionFile(args, sessionDirectory, cwd) {
  if (hasOption(args, "--no-session", "--resume", "-r")) return undefined;
  const requested = optionValue(args, "--session");
  if (requested) {
    if (
      isAbsolute(requested) ||
      requested.includes("/") ||
      requested.includes("\\") ||
      requested.endsWith(".jsonl")
    ) {
      return resolve(cwd, requested);
    }
    return sessionFiles(sessionDirectory).find((path) => {
      const id = sessionId(path);
      return id === requested || id?.startsWith(requested);
    });
  }
  const exactId = optionValue(args, "--session-id");
  if (exactId) {
    return sessionFiles(sessionDirectory).find(
      (path) => sessionId(path) === exactId,
    );
  }
  if (hasOption(args, "--continue", "-c")) {
    return sessionFiles(sessionDirectory)
      .map((path) => ({ path, modified: statSync(path).mtimeMs }))
      .sort((left, right) => right.modified - left.modified)[0]?.path;
  }
  return undefined;
}

function storedGenomeReference(sessionFile) {
  if (!sessionFile) return undefined;
  const entry = readSessionEntries(sessionFile)
    .filter(
      (candidate) =>
        candidate.type === "custom" &&
        candidate.customType === "rsih.genome",
    )
    .at(-1);
  if (!entry?.data?.genome) return undefined;
  return {
    genome: entry.data.genome,
    reference: entry.data.reference ?? entry.data.genome.genome_id,
    path: undefined,
    baseDirectory: entry.data.baseDirectory,
  };
}

function mockResponsesFromProfiles(profiles) {
  return Object.fromEntries(
    Object.entries(profiles)
      .filter(([, profile]) => profile.kind === "mock")
      .map(([id, profile]) => [
        id,
        profile.mock_responses ?? profile.responses ?? [],
      ]),
  );
}

function builtinProviderProfiles() {
  return {
    gpt: resolveProviderProfile("gpt", {
      kind: "http",
      api: "openai-responses",
      provider: "openai",
      model_env: "GPT_MODEL",
      base_url_env: "GPT_API_BASE_URL",
      api_key_env: "GPT_API_KEY",
      max_tokens: 16384,
      capabilities: {
        tools: true,
        structured_output: true,
        streaming: false,
        reasoning: true,
        images: false,
        usage: true,
      },
    }),
    local: resolveProviderProfile("local", {
      kind: "http",
      api: "openai-completions",
      provider: "local",
      model_env: "LOCAL_MODEL_ID",
      base_url_env: "LOCAL_MODEL_BASE_URL",
      api_key_env: "LOCAL_MODEL_API_KEY",
      allow_unauthenticated: true,
      reasoning: true,
      max_tokens: 24576,
      timeout_ms: 3600000,
      chat_template_kwargs: { enable_thinking: true },
      compat: { supportsStrictMode: false },
      capabilities: {
        tools: true,
        structured_output: false,
        streaming: false,
        reasoning: true,
        images: false,
        usage: true,
      },
    }),
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function fromPiContext(context: Context) {
  return context.messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", content: messageText(message.content) };
    }
    if (message.role === "toolResult") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: messageText(message.content),
        is_error: message.isError,
      };
    }
    return {
      role: "assistant",
      content: message.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join(""),
      tool_calls: message.content
        .filter((item) => item.type === "toolCall")
        .map((item) => ({
          id: item.id,
          name: item.name,
          arguments: item.arguments,
        })),
      stop_reason:
        message.stopReason === "toolUse" ? "tool_use" : message.stopReason,
    };
  });
}

function toUsage(usage = {}): Usage {
  return {
    ...EMPTY_USAGE,
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? usage.cache_read ?? 0,
    cacheWrite: usage.cacheWrite ?? usage.cache_write ?? 0,
    totalTokens: usage.totalTokens ?? usage.total_tokens ?? 0,
    cost: { ...EMPTY_USAGE.cost, ...(usage.cost ?? {}) },
  };
}

function streamProfile(
  runtime,
  profileId,
  genome,
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  void runtime
    .generate(profileId, {
      system: context.systemPrompt,
      messages: fromPiContext(context),
      tools: context.tools ?? [],
      maxTokens: options?.maxTokens ?? genome.model_options?.max_tokens,
      temperature: options?.temperature ?? genome.model_options?.temperature,
      chatTemplateKwargs: genome.model_options?.chat_template_kwargs,
      timeoutMs: options?.timeoutMs,
      maxRetries: options?.maxRetries,
      signal: options?.signal,
    })
    .then((response) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [
          ...(response.reasoning
            ? [{ type: "thinking", thinking: response.reasoning }]
            : []),
          ...(response.text ? [{ type: "text", text: response.text }] : []),
          ...(response.tool_calls ?? []).map((call) => ({
            type: "toolCall",
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? {},
          })),
        ],
        api: model.api,
        provider: profileId,
        model: response.model ?? model.id,
        responseId: response.response_id ?? undefined,
        usage: toUsage(response.usage),
        stopReason:
          response.stop_reason === "tool_use"
            ? "toolUse"
            : response.stop_reason === "length"
              ? "length"
              : "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: message.stopReason, message });
    })
    .catch((error) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: profileId,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      stream.push({
        type: "error",
        reason: message.stopReason,
        error: message,
      });
    });
  return stream;
}

function registerProfiles(pi: ExtensionAPI, profiles, genome) {
  const runtime = new ModelRuntime({
    profiles,
    mockResponses: mockResponsesFromProfiles(profiles),
  });
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (!profile.model) continue;
    const api = `rsih-${profileId}`;
    pi.registerProvider(profileId, {
      name: profileId,
      baseUrl: profile.base_url ?? "http://127.0.0.1",
      apiKey: profile.api_key ?? "rsih-runtime",
      api,
      authHeader: false,
      models: [
        {
          id: profile.model,
          name: profile.model,
          api,
          reasoning:
            profile.reasoning === true ||
            profile.capabilities?.reasoning === true,
          input: profile.capabilities?.images ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: profile.context_window ?? 128000,
          maxTokens: profile.max_tokens ?? 16384,
        },
      ],
      streamSimple: (model, context, options) =>
        streamProfile(runtime, profileId, genome, model, context, options),
    });
  }
}

function supplementalSystemPrompt(genome) {
  return renderHarnessSystemPrompt({
    ...genome,
    system_prompt: "",
    append_system_prompt: "",
  });
}

/**
 * The two prompt strings a Genome contributes, assembled once so startup (which
 * puts them on argv) and `/switch-genome` (which has to replace exactly these
 * strings in a live prompt) can never disagree about what the Genome said.
 */
function genomeInstructions(genome) {
  const appendPrompt = [genome.append_system_prompt, supplementalSystemPrompt(genome)]
    .filter(Boolean)
    .join("\n\n");
  return {
    systemPrompt: genome.system_prompt || undefined,
    appendPrompt: appendPrompt || undefined,
  };
}

/**
 * The model a Genome asks for, as a Pi model object. A Genome names either an
 * RSIH provider profile plus a model id, or just an id; the second form has to
 * be searched for because the provider is whatever registered that id.
 */
function findGenomeModel(modelRegistry, model) {
  if (!model?.id) return undefined;
  if (model.profile) return modelRegistry.find(model.profile, model.id);
  return modelRegistry.getAll().find((candidate) => candidate.id === model.id);
}

function registerInlineResources(pi: ExtensionAPI, genome) {
  const inlineSkills = (genome.skills ?? []).filter(
    (skill) => typeof skill === "object" && skill.source === undefined,
  );
  if (inlineSkills.length > 0) {
    const byName = new Map(inlineSkills.map((skill) => [skill.name, skill]));
    pi.registerTool({
      name: "load_skill",
      label: "Load skill",
      description: "Load the complete instructions for an inline Genome skill.",
      parameters: Type.Object({ name: Type.String() }),
      async execute(_toolCallId, { name }) {
        const skill = byName.get(name);
        if (!skill) {
          throw new Error(`Unknown Genome skill "${name}".`);
        }
        return {
          content: [
            {
              type: "text",
              text: [
                `Skill: ${skill.name}`,
                `Description: ${skill.description}`,
                "Instructions:",
                skill.content,
              ].join("\n"),
            },
          ],
          details: {},
        };
      },
    });
    for (const skill of inlineSkills) {
      pi.registerCommand(`skill:${skill.name}`, {
        description: skill.description,
        async handler(args, ctx) {
          pi.sendUserMessage(
            [`Use the "${skill.name}" skill.`, skill.content, args]
              .filter(Boolean)
              .join("\n\n"),
          );
        },
      });
    }
  }

  // File-backed templates are discovered by Pi through `resources_discover`;
  // only inline ones become commands here.
  const inlineTemplates = (genome.prompt_templates ?? []).filter(
    (template) =>
      template && typeof template === "object" && template.source === undefined,
  );
  for (const template of inlineTemplates) {
    pi.registerCommand(template.name, {
      description: template.description ?? "",
      async handler(args) {
        pi.sendUserMessage(
          [template.content, args].filter(Boolean).join("\n\n"),
        );
      },
    });
  }
}

function registerScratchpad(pi: ExtensionAPI, genome) {
  if (!genome.policies?.scratchpad?.enabled) return;
  const values = new Map();
  const policy = genome.policies.scratchpad;
  pi.registerTool({
    name: "scratchpad",
    label: "Scratchpad",
    description: "Read or update session-only Genome state.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("get"),
        Type.Literal("set"),
        Type.Literal("append"),
        Type.Literal("delete"),
      ]),
      key: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, { action, key, value }) {
      if (action === "list") {
        return {
          content: [{ type: "text", text: JSON.stringify(Object.fromEntries(values)) }],
          details: {},
        };
      }
      if (!key) throw new Error(`Scratchpad action "${action}" requires key.`);
      if (action === "get") {
        return {
          content: [{ type: "text", text: values.get(key) ?? "" }],
          details: {},
        };
      }
      if (action === "delete") {
        values.delete(key);
        return {
          content: [{ type: "text", text: `Deleted ${key}` }],
          details: {},
        };
      }
      if (typeof value !== "string") {
        throw new Error(`Scratchpad action "${action}" requires value.`);
      }
      if (!values.has(key) && values.size >= Number(policy.max_entries ?? 32)) {
        throw new Error(`Scratchpad is limited to ${policy.max_entries ?? 32} entries.`);
      }
      const updated = action === "append" ? `${values.get(key) ?? ""}${value}` : value;
      if (updated.length > Number(policy.max_value_chars ?? 4000)) {
        throw new Error(
          `Scratchpad values are limited to ${policy.max_value_chars ?? 4000} characters.`,
        );
      }
      values.set(key, updated);
      return {
        content: [{ type: "text", text: `Stored ${key}` }],
        details: {},
      };
    },
  });
}

/**
 * Tools whose implementation belongs to Pi. A Genome can enable, disable, and
 * narrow their parameters, but it cannot restate their description: doing so
 * would mean re-registering — and therefore reimplementing — Pi's tool.
 */
function genomeNarrowedSchemas(genome) {
  const narrowed = new Map();
  for (const tool of genome.tools ?? []) {
    if (tool.parameters) narrowed.set(toolName(tool.name), tool.parameters);
  }
  return narrowed;
}

/** Pi calls its directory-listing tool `ls`; older Genomes wrote `list`. */
function toolName(name) {
  return name === "list" ? "ls" : name;
}

/**
 * Genome `tools` entries are a patch on whatever Pi already activated, not a
 * whitelist. A Genome that never mentions tools keeps Pi's full tool set, and a
 * Genome that disables one tool keeps the rest.
 *
 * `previous` is the Genome being switched away from. Reload carries the current
 * active tool set forward, so without releasing that Genome's disables first, a
 * tool switched off by a Genome that is no longer running would stay off --
 * the same residue `mergeManagedSettings` releases for settings.
 */
export function genomeActiveToolNames(activeToolNames, allToolNames, genome, previous) {
  const entries = genome.tools ?? [];
  const released = releasedToolNames(previous, entries);
  if (entries.length === 0 && released.length === 0) return undefined;

  const known = new Set(allToolNames);
  const active = new Set(activeToolNames);
  for (const name of released) {
    if (known.has(name)) active.add(name);
  }
  for (const tool of entries) {
    const name = toolName(tool.name);
    if (tool.enabled === false) {
      active.delete(name);
    } else if (known.has(name)) {
      active.add(name);
    }
  }
  return allToolNames.filter((name) => active.has(name));
}

/** Tools the outgoing Genome disabled that the incoming one does not mention. */
function releasedToolNames(previous, entries) {
  if (!previous) return [];
  const mentioned = new Set(entries.map((tool) => toolName(tool.name)));
  return (previous.tools ?? [])
    .filter((tool) => tool.enabled === false)
    .map((tool) => toolName(tool.name))
    .filter((name) => !mentioned.has(name));
}

/**
 * What to tell the user about the relationship between their installed Genome
 * and the one this RSIH ships. A stale unmodified copy is refreshed silently by
 * the loader, but the user still needs to know their Genome changed underneath
 * them; a modified copy is never touched, so the only honest move is to say a
 * newer version exists and leave the decision to them.
 */
export function genomeSeedNotice(resolvedGenome, label) {
  if (resolvedGenome.seeded) {
    return {
      message: `Installed Genome "${label}" to ${dirname(resolvedGenome.path)}`,
      level: "info",
    };
  }
  if (resolvedGenome.refreshed) {
    return {
      message: `Updated Genome "${label}" to the version shipped with this RSIH`,
      level: "info",
    };
  }
  if (resolvedGenome.outdated) {
    return {
      message: `Genome "${label}" differs from the version shipped with this RSIH. Run \`rsih genome install ${label}\` to replace your copy.`,
      level: "warning",
    };
  }
  return undefined;
}

export function genomeFooterStatus(label) {
  return `\u001b[35mGenome: ${label}\u001b[39m`;
}

function genomeResourceLabels(entries): string[] {
  return (entries ?? [])
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.split(/[\\/]/).filter(Boolean).at(-1) ?? entry;
      }
      if (!entry || typeof entry !== "object") return "";
      return (
        entry.name ??
        entry.source?.split(/[\\/]/).filter(Boolean).at(-1) ??
        ""
      );
    })
    .filter(
      (label): label is string =>
        typeof label === "string" && label.length > 0,
    );
}

function resourcePathLabel(path: string): string {
  if (path.startsWith("<") && path.endsWith(">")) return path;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function runtimeResourceLabels(pi, genome) {
  const skills = new Set(genomeResourceLabels(genome.skills));
  const extensions = new Set(genomeResourceLabels(genome.extensions));

  for (const command of pi.getCommands()) {
    if (command.source === "skill") {
      skills.add(command.name.replace(/^skill:/, ""));
    } else if (command.source === "extension") {
      extensions.add(resourcePathLabel(command.sourceInfo.path));
    }
  }

  for (const tool of pi.getAllTools()) {
    const sourcePath = tool.sourceInfo?.path;
    if (sourcePath && !sourcePath.startsWith("<builtin")) {
      extensions.add(resourcePathLabel(sourcePath));
    }
  }

  return {
    skills: [...skills].sort(),
    extensions: [...extensions].sort(),
  };
}

/**
 * Everything the runtime derives from one resolved Genome, in one record.
 *
 * Startup and `/switch-genome` both go through here, so a switched session is
 * described by exactly the same derivation as a freshly started one -- there is
 * no second, drifting copy of "what this Genome means".
 */
export function genomeActivation(resolved, { profiles = {}, preserveSessionDefaults = false } = {}) {  const genome = resolved.genome;
  const label = genomeDisplayName(resolved);
  const profile = genome.model?.profile;
  return {
    resolved,
    genome,
    reference: resolved.reference,
    label,
    baseDirectory: resolve(resolved.baseDirectory ?? process.cwd()),
    instructions: genomeInstructions(genome),
    modelLabel: genome.model?.id ?? (profile ? profiles[profile]?.model : undefined) ?? "",
    seedNotice: genomeSeedNotice(resolved, label),
    showGenomeStatus: resolved.reference !== "default",
    preserveSessionDefaults,
  };
}

/**
 * Build the inline extension that carries a Genome into a running Pi session.
 *
 * `session` rather than a Genome, because `ctx.reload()` re-invokes this factory
 * and the new invocation has to pick up whatever `/switch-genome` left in the
 * holder. Everything else here is genuinely per-process: CLI overrides, provider
 * profiles, and the cwd.
 */
/**
 * Tell the user, and the model, that the harness changed underneath them.
 *
 * The model needs this as context rather than as a notification: it is still
 * holding a conversation that started under different instructions, and the
 * turn it is about to take should be taken under the new ones.
 */
function reportGenomeSwitch(pi, ctx, announcement) {
  const { from, to, caveats } = announcement;
  if (ctx.mode === "tui") {
    ctx.ui.notify(`Genome: ${from} -> ${to}`, "info");
    for (const caveat of caveats) ctx.ui.notify(caveat, "warning");
  }
  const lines = [
    `The harness switched from the "${from}" Genome to "${to}" mid-session.`,
    "The conversation so far happened under the previous Genome; from this turn on you are running under the new one, and its instructions take precedence.",
  ];
  if (caveats.length > 0) {
    lines.push(
      `The switch was not complete. Do not assume the following were applied: ${caveats.join("; ")}.`,
    );
  }
  pi.sendMessage(
    {
      customType: "rsih.genome-switch",
      content: lines.join("\n\n"),
      display: true,
      details: { from, to, caveats },
    },
    { deliverAs: "nextTurn" },
  );
}

/**
 * A supervised restart is a switch that already happened: the Genome is fully
 * loaded, nothing was left behind. Read once, so a later in-process reload
 * does not announce it a second time.
 */
function restartAnnouncement(active) {
  const from = process.env[SWITCHED_FROM_ENV];
  if (!from) return undefined;
  delete process.env[SWITCHED_FROM_ENV];
  return { from, to: active.label, caveats: [] };
}

/**
 * `/switch-genome <name>` -- replace the running harness without losing the
 * conversation.
 *
 * Registered at factory time on purpose: Pi rebuilds the slash-command
 * autocomplete list only at startup and reload, so a lazily registered command
 * would dispatch but never complete.
 */
function registerGenomeSwitch(pi: ExtensionAPI, { session, profiles, cwd }) {
  pi.registerCommand("switch-genome", {
    description: "Switch the active Genome, keeping the current conversation",
    getArgumentCompletions(prefix) {
      const active = session.current().reference;
      return availableGenomeNames({ cwd })
        .filter((name) => name !== active && name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
    },
    async handler(args, ctx) {
      const reference = args.trim();
      if (!reference) {
        const names = availableGenomeNames({ cwd });
        ctx.ui.notify(
          `Usage: /switch-genome <name>. Available: ${names.join(", ") || "(none)"}`,
          "info",
        );
        return;
      }
      if (typeof ctx.reload !== "function") {
        ctx.ui.notify(
          "Switching Genomes needs a reloadable session; this run mode does not support it.",
          "error",
        );
        return;
      }

      // Nothing below this point may touch shared state until the Genome has
      // resolved: a typo must leave the session exactly as it was.
      let next;
      try {
        next = genomeActivation(
          resolveHarnessGenome(reference, { cwd, homeDirectory: homedir() }),
          { profiles },
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }

      const previous = session.current();
      if (next.genome.genome_id === previous.genome.genome_id) {
        ctx.ui.notify(`Already running ${previous.label}.`, "info");
        return;
      }

      // reload() refuses outright while the agent is streaming or compacting.
      await ctx.waitForIdle();

      // Under the supervisor a switch is a restart on the same session file:
      // the only route that also carries a Genome's argv-only parts across.
      // The request is written before Pi's own quit path runs, and the
      // supervisor picks it up once this process has handed the terminal back.
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (
        ctx.mode === "tui" &&
        process.env[SUPERVISED_ENV] === "1" &&
        sessionFile
      ) {
        writeSwitchRequest(getPiAgentDir(), {
          reference,
          sessionFile,
          from: previous.label,
        });
        ctx.shutdown();
        return;
      }

      // No supervisor (RPC, print, or a session that is not being persisted):
      // switch in place. Everything a live session can take is taken; what it
      // cannot is reported rather than dropped.
      const caveats = unswitchableDifferences(previous.genome, next.genome);
      const probe = switchedSystemPrompt({
        base: ctx.getSystemPrompt(),
        options: ctx.getSystemPromptOptions(),
        startup: session.startup(),
        target: next.instructions,
      });
      caveats.push(...(probe?.caveats ?? []));

      // Reproject before reloading: reload is what makes Pi re-read these, and
      // mergeManagedSettings drops keys the previous Genome managed.
      const projection = projectGenomeSettings(next.genome);
      applyManagedConfiguration({
        agentDirectory: getPiAgentDir(),
        settings: { ...RSIH_BASE_SETTINGS, ...projection.settings },
        keybindings: projection.keybindings,
        stamp: {
          genome: next.reference,
          genomeId: next.genome.genome_id,
          rsih: RSIH_VERSION,
        },
      });

      const model = findGenomeModel(ctx.modelRegistry, next.genome.model);
      if (next.genome.model?.id && !model) {
        caveats.push(
          `the model ${next.genome.model.id} this Genome asks for was not found, so the current model is still in use`,
        );
      } else if (model && !(await pi.setModel(model))) {
        caveats.push(
          `no API key is configured for ${model.id}, so the current model is still in use`,
        );
      }
      if (next.genome.runtime?.thinking_level) {
        pi.setThinkingLevel(next.genome.runtime.thinking_level);
      }

      session.switchTo(next, {
        from: previous.label,
        to: next.label,
        caveats,
      });

      // Terminal for this handler: reload tears down the session this `ctx`
      // belongs to, so the report happens in the new `session_start`.
      await ctx.reload();
      return;
    },
  });
}

async function createGenomeExtension({
  session,
  profiles,
  maxTurns: cliMaxTurns,
  cliOverridesTools,
  cliOverridesThinking,
  cwd,
}): Promise<ExtensionFactory> {
  return async (pi) => {
    const active = session.current();
    const genome = active.genome;
    const maxTurns = cliMaxTurns ?? genome.runtime?.max_turns;
    const activeResources = {
      skills: genomeResourceLabels(genome.skills),
      extensions: genomeResourceLabels(genome.extensions),
    };
    const narrowedSchemas = genomeNarrowedSchemas(genome);

    // RSIH consumes these before Pi parses argv; registering them is what puts
    // them in `--help` alongside Pi's own options.
    pi.registerFlag("genome", {
      type: "string",
      description:
        "Genome name or JSON path (./.rsih/genomes, then ~/.rsih/genomes). Shorthand: rsih +name, :name or ::name.",
      default: active.reference,
    });
    for (const [name, description] of RSIH_FLAG_DESCRIPTIONS) {
      pi.registerFlag(name, { type: "string", description });
    }
    pi.registerFlag("json", {
      type: "boolean",
      description: "Shorthand for --mode json.",
    });
    pi.registerFlag("new", {
      type: "boolean",
      description: "Start a fresh session instead of resuming.",
    });
    registerProfiles(pi, profiles, genome);
    registerInlineResources(pi, genome);
    registerScratchpad(pi, genome);
    registerGenomeSwitch(pi, { session, profiles, cwd });

    for (const tool of createGeneratedTools({ cwd, genome })) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        executionMode: genome.runtime?.tool_execution,
        async execute(_toolCallId, params, signal) {
          const text = await tool.execute(params, { signal });
          return {
            content: [{ type: "text", text: String(text ?? "") }],
            details: {},
          };
        },
      });
    }

    const mcp = await createMcpTools({ cwd, genome });
    for (const tool of mcp.tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        executionMode: genome.runtime?.tool_execution,
        async execute(_toolCallId, params, signal) {
          const text = await tool.execute(params, { signal });
          return {
            content: [{ type: "text", text: String(text ?? "") }],
            details: {},
          };
        },
      });
    }

    pi.on("resources_discover", () =>
      projectGenomeResources(genome, (path) => resolve(active.baseDirectory, path)),
    );

    pi.on("before_provider_request", (event) =>
      applyModelOptionsToPayload(event.payload, genome.model_options),
    );

    // The only door Pi leaves open for prompt text once a session is running.
    // Pi clears the override in the `finally` of every agent run, so this has to
    // answer on every turn, not just the first one after a switch.
    pi.on("before_agent_start", (event) => {
      const switched = switchedSystemPrompt({
        base: event.systemPrompt,
        options: event.systemPromptOptions,
        startup: session.startup(),
        target: active.instructions,
      });
      return switched ? { systemPrompt: switched.prompt } : undefined;
    });

    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode === "tui") {
        const loadedResources = runtimeResourceLabels(pi, genome);
        activeResources.skills = loadedResources.skills;
        activeResources.extensions = loadedResources.extensions;
        ctx.ui.setHeader((tui, theme) =>
          createRsiHeader(theme, {
            cwd,
            model: ctx.model?.id ?? active.modelLabel,
            genome: active.label,
            version: RSIH_VERSION,
            resources: activeResources,
          }),
        );
        ctx.ui.setEditorComponent(
          (tui, theme, keybindings) => createRsiEditor(tui, theme, keybindings),
        );
      }

      if (active.showGenomeStatus && ctx.mode === "tui") {
        ctx.ui.setStatus("rsih-genome", genomeFooterStatus(active.label));
      }

      if (active.seedNotice && ctx.mode === "tui") {
        ctx.ui.notify(active.seedNotice.message, active.seedNotice.level);
      }

      // Reported here rather than in the command handler because `ctx.reload()`
      // tears the handler's session down: this is the first point at which the
      // switched-to Genome is actually the one running. A supervised restart
      // arrives the same way, carrying its origin in the environment.
      const announcement = session.takeAnnouncement() ?? restartAnnouncement(active);
      if (announcement) reportGenomeSwitch(pi, ctx, announcement);

      const prior = ctx.sessionManager
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "rsih.genome",
        )
        .at(-1);
      if (
        prior?.data?.genome_id !== genome.genome_id ||
        prior?.data?.reference !== active.reference
      ) {
        pi.appendEntry("rsih.genome", {
          reference: active.reference,
          baseDirectory: active.baseDirectory,
          genome_id: genome.genome_id,
          genome,
        });
      }

      if (!cliOverridesTools) {
        const activeTools = genomeActiveToolNames(
          pi.getActiveTools(),
          pi.getAllTools().map((tool) => tool.name),
          genome,
          active.previousGenome,
        );
        if (activeTools) pi.setActiveTools(activeTools);
      }
      if (
        !cliOverridesThinking &&
        !active.preserveSessionDefaults &&
        genome.runtime?.thinking_level
      ) {
        pi.setThinkingLevel(genome.runtime.thinking_level);
      }
    });

    pi.on("turn_start", (event, ctx) => {
      // Pi has no turn cap of its own, so only enforce one that was asked for.
      if (maxTurns !== undefined && event.turnIndex >= maxTurns) ctx.abort();
    });
    pi.on("tool_call", (event) => {
      if (genome.policies?.tool?.blocked_tools?.includes(event.toolName)) {
        return {
          block: true,
          reason: `Tool "${event.toolName}" is blocked by Genome policy.`,
        };
      }
      // Pi owns its tool implementations, so a Genome narrows a tool by
      // rejecting out-of-contract calls rather than re-registering the tool.
      const schema = narrowedSchemas.get(event.toolName);
      if (schema) {
        const errors = validateJsonSchema(event.input, schema);
        if (errors.length > 0) {
          return {
            block: true,
            reason: `Tool "${event.toolName}" was called outside its Genome parameter contract:\n- ${errors.join("\n- ")}`,
          };
        }
      }
      return undefined;
    });
    pi.on("tool_result", (event) => {
      const maxChars = genome.policies?.tool?.max_result_chars;
      if (maxChars === undefined) return undefined;
      let remaining = Number(maxChars);
      let truncated = false;
      const content = event.content.map((item) => {
        if (item.type !== "text") return item;
        if (item.text.length <= remaining) {
          remaining -= item.text.length;
          return item;
        }
        truncated = true;
        const text = `${item.text.slice(0, Math.max(0, remaining))}\n[truncated]`;
        remaining = 0;
        return { ...item, text };
      });
      return truncated ? { content } : undefined;
    });
    pi.on("session_shutdown", async () => {
      await mcp.close();
    });
  };
}

/**
 * Mirror of Pi's default session directory (`<agentDir>/sessions/--<cwd>--`).
 * RSIH only needs it to find the Genome snapshot stored in a resumed session;
 * Pi still owns session creation and layout.
 *
 * This runs before the Genome's settings are compiled, so it reads the settings
 * file as it stands — which is where the run being resumed put its sessions.
 */
function piSessionDirectory(cwd, piArgs) {
  const agentDirectory = getPiAgentDir();
  const settingsPath = join(agentDirectory, "settings.json");
  let settingsSessionDir;
  if (existsSync(settingsPath)) {
    try {
      settingsSessionDir = JSON.parse(readFileSync(settingsPath, "utf8"))
        ?.sessionDir;
    } catch {
      // Pi reports malformed settings; fall back to its default layout.
    }
  }
  const explicit =
    optionValue(piArgs, "--session-dir") ??
    process.env.RSIH_CODING_AGENT_SESSION_DIR ??
    settingsSessionDir;
  if (explicit) return resolve(cwd, explicit);
  const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDirectory, "sessions", encoded);
}

export async function runPiCli(argv) {
  // `rsih genome ...` is RSIH's own subcommand; everything else, including Pi's
  // install/update/list/config/auth subcommands, falls through to Pi.
  if (runGenomeCommand(argv)) return;

  const parsed = parseCliArgs(argv);
  if (
    parsed.newSession &&
    hasOption(parsed.piArgs, "--continue", "-c", "--resume", "-r", "--session")
  ) {
    throw new Error("--new cannot be combined with session resume options.");
  }

  process.chdir(resolve(parsed.cwd));
  // Read the directory back so RSIH and Pi agree on the canonical cwd; on
  // macOS `/tmp` and `/var` resolve through symlinks and the session directory
  // Pi derives would not match.
  const cwd = process.cwd();
  if (parsed.env) {
    loadEnvFile(resolve(cwd, parsed.env));
  } else {
    try {
      loadEnvFile(join(cwd, ".env"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  // Session storage stays wherever Pi puts it, so `rsih` and `pi` resume the
  // same way. A Genome that wants project-local runs sets its own session dir.
  const sessionDirectory = piSessionDirectory(cwd, parsed.piArgs);
  const existingSession = findSessionFile(parsed.piArgs, sessionDirectory, cwd);
  const storedGenome =
    parsed.genome === undefined
      ? storedGenomeReference(existingSession)
      : undefined;
  const resolvedGenome =
    storedGenome ??
    resolveHarnessGenome(parsed.genome, {
      cwd,
      homeDirectory: homedir(),
    });
  const { genome } = resolvedGenome;

  // Pi exposes no API for settings or keybindings, so the Genome's projection
  // is compiled into the files Pi reads. Only Genome-declared keys are touched.
  const projection = projectGenomeSettings(genome);
  applyManagedConfiguration({
    agentDirectory: getPiAgentDir(),
    settings: { ...RSIH_BASE_SETTINGS, ...projection.settings },
    keybindings: projection.keybindings,
    stamp: {
      genome: resolvedGenome.reference,
      genomeId: genome.genome_id,
      rsih: RSIH_VERSION,
    },
  });

  const profiles = parsed.config
    ? loadProviderProfiles(resolve(cwd, parsed.config))
    : builtinProviderProfiles();
  const selectedProfile = parsed.profile ?? genome.model?.profile;
  const selectedModel =
    optionValue(parsed.piArgs, "--model") ??
    genome.model?.id ??
    (selectedProfile ? profiles[selectedProfile]?.model : undefined);
  const preserveSessionDefaults = existingSession !== undefined && parsed.genome === undefined;
  const genomeArgs = [];

  if (
    !preserveSessionDefaults &&
    !hasOption(parsed.piArgs, "--provider") &&
    selectedProfile
  ) {
    genomeArgs.push("--provider", selectedProfile);
  }
  if (
    !preserveSessionDefaults &&
    !hasOption(parsed.piArgs, "--model") &&
    selectedModel
  ) {
    genomeArgs.push("--model", selectedModel);
  }
  // A Genome's instructions are argv-only, so what actually reached Pi has to
  // be recorded verbatim: `/switch-genome` replaces exactly these strings later.
  const instructions = genomeInstructions(genome);
  const startupPrompts = startupPromptRecord({
    systemPrompt:
      hasOption(parsed.piArgs, "--system-prompt") ? undefined : instructions.systemPrompt,
    appendPrompt:
      hasOption(parsed.piArgs, "--append-system-prompt") ? undefined : instructions.appendPrompt,
  });
  // Only replace Pi's own system prompt when the Genome actually declares one.
  if (startupPrompts.systemPrompt) {
    genomeArgs.push("--system-prompt", startupPrompts.systemPrompt);
  }
  if (startupPrompts.appendPrompt) {
    genomeArgs.push("--append-system-prompt", startupPrompts.appendPrompt);
  }
  // Skills, prompt templates, and themes reach Pi through the
  // `resources_discover` hook. Extensions have no such hook, so they stay on
  // argv; explicit `-e` paths keep working even under resource isolation.
  const baseDirectory = resolve(resolvedGenome.baseDirectory ?? cwd);
  for (const path of resolveGenomeSources(genome.extensions, baseDirectory)) {
    genomeArgs.push("--extension", path);
  }
  genomeArgs.push(...genomeAppearanceArgs(genome, parsed.piArgs));
  genomeArgs.push(...genomeResourceIsolationArgs(genome, parsed.piArgs));
  if (parsed.genome !== undefined) {
    genomeArgs.push("--genome", parsed.genome);
  }

  const customProfiles =
    parsed.config || (selectedProfile && ["gpt", "local"].includes(selectedProfile))
      ? profiles
      : {};
  if (selectedProfile && parsed.config && !profiles[selectedProfile]) {
    throw new Error(
      `Provider profile "${selectedProfile}" was not found in ${resolve(cwd, parsed.config)}.`,
    );
  }
  if (
    selectedProfile &&
    Object.hasOwn(customProfiles, selectedProfile) &&
    !customProfiles[selectedProfile].model
  ) {
    throw new Error(
      `Provider profile "${selectedProfile}" has no resolved model.`,
    );
  }

  // The holder, not the Genome, is what the extension closes over: `ctx.reload()`
  // re-invokes the factory and the new invocation has to see whatever
  // `/switch-genome` put here.
  //
  // A built-in Genome is copied into ~/.rsih/genomes on first use, so that the
  // Genome the agent runs -- and reads its skills from -- is always the one in
  // the user's own directory. Every write, and every refusal to write, is
  // announced rather than done silently; `genomeActivation` carries that notice.
  const session = createGenomeSession(
    genomeActivation(resolvedGenome, {
      profiles: customProfiles,
      preserveSessionDefaults,
    }),
    startupPrompts,
  );

  const extensionFactory = await createGenomeExtension({
    session,
    profiles: customProfiles,
    maxTurns: parsed.maxTurns,
    cliOverridesTools: hasOption(
      parsed.piArgs,
      "--tools",
      "-t",
      "--exclude-tools",
      "-xt",
      "--no-tools",
      "-nt",
      "--no-builtin-tools",
      "-nbt",
    ),
    cliOverridesThinking: hasOption(parsed.piArgs, "--thinking"),
    cwd,
  });
  await runPiMain([...genomeArgs, ...parsed.piArgs], {
    extensionFactories: [extensionFactory],
  });
}
