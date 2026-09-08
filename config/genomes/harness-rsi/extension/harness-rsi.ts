/**
 * harness-rsi Genome extension.
 *
 * Three tools and one boot nudge. Everything else -- how to read long sessions,
 * how to rank candidates, what a pattern should become -- lives in the
 * `genome-authoring` skill and the Genome's system prompt, because the agent the
 * user is talking to is the thing that should be doing that reasoning. This file
 * only supplies what the agent genuinely cannot reach on its own:
 *
 *   1. `scan_workspaces`   - session stores are keyed by encoded paths, span more
 *                            than one harness, and are too large to read whole.
 *   2. `choose_workspaces` - a multi-select page needs keyboard focus, which only
 *                            an extension can take.
 *   3. `AskUserQuestion`   - Pi's own clarification dialog, carried here because
 *                            it is a core built-in upstream but not in the
 *                            released package this Genome runs against.
 *
 * No model calls happen here.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SOURCE_IDS,
  readExtraRoots,
  readSessions,
  SESSION_SOURCES,
  sourceIds,
  type SessionRecord,
} from "./session-sources.ts";
import {
  AskUserQuestionDialog,
  type AskUserQuestionDialogResult,
} from "./ask-user-question-dialog.ts";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const EXCERPT_CHARS = 240;
const DEFAULT_LIMIT = 20;

const BOOT_PROMPT = [
  "A Genome authoring session has started.",
  "Run step 1 of the required sequence and nothing else yet:",
  "ask in the chat, as plain text, what this Genome is for --",
  "in the user's own words and in detail. Then wait for the answer.",
].join(" ");

/* ------------------------------------------------------------------ scanning */

function expandHome(path: string) {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function excerpt(text: string, limit = EXCERPT_CHARS) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

/**
 * Lexical prefilter only. Ranking and descriptions are the agent's job, so the
 * score is returned as its own field rather than baked into an opaque order.
 */
function keywordScore(workspace, keywords: string[]) {
  if (keywords.length === 0) return { score: 0, matched: [] as string[] };
  const pathText = workspace.path.toLowerCase();
  const promptText = workspace.promptText;
  let score = 0;
  const matched: string[] = [];
  for (const raw of keywords) {
    const keyword = raw.toLowerCase().trim();
    if (!keyword) continue;
    let hit = 0;
    if (pathText.includes(keyword)) hit += 8;
    if (promptText.includes(keyword)) hit += 4;
    if (hit > 0) matched.push(raw);
    score += hit;
  }
  return { score, matched };
}

/** Prompt text retained per workspace for scoring. Never returned. */
const MAX_PROMPT_TEXT_CHARS = 20000;
/** Session file paths listed per workspace when the caller focuses on it. */
const MAX_LISTED_FILES = 60;

function newWorkspace(cwd: string, record: SessionRecord) {
  return {
    path: cwd,
    sessions: 0,
    bytes: 0,
    firstSeen: record.created,
    lastSeen: record.modified,
    bySource: new Map<string, { sessions: number; bytes: number }>(),
    files: [] as string[],
    excerpts: [] as string[],
    promptsSampled: 0,
    promptsComplete: true,
    // Kept only for scoring; never returned to the model.
    promptText: "",
  };
}

function absorb(workspace, record: SessionRecord) {
  workspace.sessions += 1;
  workspace.bytes += record.bytes;
  if (record.created < workspace.firstSeen) workspace.firstSeen = record.created;
  if (record.modified > workspace.lastSeen) workspace.lastSeen = record.modified;

  const source = workspace.bySource.get(record.source) ?? { sessions: 0, bytes: 0 };
  source.sessions += 1;
  source.bytes += record.bytes;
  workspace.bySource.set(record.source, source);

  workspace.files.push(record.path);
  if (!record.promptsComplete) workspace.promptsComplete = false;
  workspace.promptsSampled += record.prompts.length;
  if (workspace.excerpts.length < 3 && record.prompts[0]) {
    workspace.excerpts.push(`[${record.source}] ${excerpt(record.prompts[0])}`);
  }
  if (workspace.promptText.length < MAX_PROMPT_TEXT_CHARS) {
    workspace.promptText += ` ${record.prompts.join(" ").toLowerCase()}`;
  }
}

async function scanWorkspaces({
  keywords = [],
  sources = DEFAULT_SOURCE_IDS,
  roots = [],
  paths = [],
  limit = DEFAULT_LIMIT,
}) {
  const scan = readSessions(sources);
  const extraRoots = roots.map(expandHome);
  const records = [...scan.records, ...readExtraRoots(extraRoots)];
  // Recent first, so the excerpts describe what the workspace was last used for.
  records.sort((a, b) => b.modified.getTime() - a.modified.getTime());

  // A focused scan answers "where are the transcripts for these workspaces",
  // which is what the analysis step needs after the user has chosen.
  const focus = new Set(paths.map(expandHome));
  const focused = focus.size > 0;

  const byCwd = new Map();
  for (const record of records) {
    const cwd = record.cwd || "(unknown)";
    if (focused && !focus.has(cwd)) continue;
    let workspace = byCwd.get(cwd);
    if (!workspace) {
      workspace = newWorkspace(cwd, record);
      byCwd.set(cwd, workspace);
    }
    absorb(workspace, record);
  }

  const scored = [...byCwd.values()].map((workspace) => ({
    workspace,
    ...keywordScore(workspace, keywords),
  }));
  // Keyword hits first, then recency. This is a prefilter for the `limit`, not a
  // verdict: the agent re-ranks and writes the descriptions.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.workspace.lastSeen.getTime() - a.workspace.lastSeen.getTime(),
  );

  const kept = focused ? scored : scored.slice(0, Math.max(1, limit));
  return {
    sources_scanned: scan.sources.map((source) => ({
      id: source.id,
      label: source.label,
      roots: source.roots,
      available: source.available,
      sessions: source.sessions,
    })),
    unknown_sources: scan.unknownSources,
    extra_roots_scanned: extraRoots,
    sessions_found: records.length,
    workspaces_found: scored.length,
    workspaces_returned: kept.length,
    workspaces_omitted: Math.max(0, scored.length - kept.length),
    ranking:
      "Lexical prefilter and recency only. Rank these yourself and write the descriptions.",
    workspaces: kept.map(({ workspace, score, matched }) => ({
      path: workspace.path,
      sessions: workspace.sessions,
      bytes: workspace.bytes,
      first_seen: workspace.firstSeen.toISOString().slice(0, 10),
      last_seen: workspace.lastSeen.toISOString().slice(0, 10),
      sources: [...workspace.bySource.entries()].map(([id, value]) => ({
        id,
        sessions: value.sessions,
        bytes: value.bytes,
      })),
      prompts_sampled: workspace.promptsSampled,
      prompts_complete: workspace.promptsComplete,
      first_messages: workspace.excerpts,
      // Full transcript paths are only worth the tokens once a workspace matters.
      session_files: focused ? workspace.files.slice(0, MAX_LISTED_FILES) : undefined,
      session_files_omitted: focused
        ? Math.max(0, workspace.files.length - MAX_LISTED_FILES)
        : undefined,
      keyword_score: score,
      matched_keywords: matched,
    })),
  };
}

/* ------------------------------------------------------------- selection page */

interface ChoiceItem {
  path: string;
  description?: string;
}

interface ChoiceResult {
  selected: string[];
  notes: string;
}

function renderSelector(
  tui,
  theme,
  done: (result: ChoiceResult | null) => void,
  { title, items, allowNotes }: { title: string; items: ChoiceItem[]; allowNotes: boolean },
) {
  let cursor = 0;
  let noteMode = false;
  let cachedLines: string[] | undefined;
  const checked = new Set<number>();

  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);

  const refresh = () => {
    cachedLines = undefined;
    tui.requestRender();
  };

  const finish = (notes: string) => {
    done({
      selected: [...checked].sort((a, b) => a - b).map((index) => items[index].path),
      notes: notes.trim(),
    });
  };

  editor.onSubmit = (value: string) => finish(value);

  function confirm() {
    if (checked.size === 0) return;
    if (!allowNotes) {
      finish("");
      return;
    }
    noteMode = true;
    refresh();
  }

  function handleInput(data: string) {
    if (noteMode) {
      if (matchesKey(data, Key.escape)) {
        noteMode = false;
        editor.setText("");
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }
    if (matchesKey(data, Key.up)) {
      cursor = Math.max(0, cursor - 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      cursor = Math.min(items.length - 1, cursor + 1);
      refresh();
      return;
    }
    if (data === " ") {
      if (checked.has(cursor)) checked.delete(cursor);
      else checked.add(cursor);
      refresh();
      return;
    }
    if (data === "a" || data === "A") {
      if (checked.size === items.length) checked.clear();
      else for (let i = 0; i < items.length; i += 1) checked.add(i);
      refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      confirm();
      return;
    }
    if (matchesKey(data, Key.escape)) done(null);
  }

  function render(width: number): string[] {
    if (cachedLines) return cachedLines;
    const renderWidth = Math.max(1, width);
    const lines: string[] = [];

    const addWrapped = (prefix: string, text: string) => {
      const prefixWidth = visibleWidth(prefix);
      if (prefixWidth >= renderWidth) {
        lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
        return;
      }
      const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
      const continuation = " ".repeat(prefixWidth);
      wrapped.forEach((line, index) => {
        lines.push(`${index === 0 ? prefix : continuation}${line}`);
      });
    };

    lines.push(theme.fg("accent", "─".repeat(renderWidth)));
    addWrapped(" ", theme.fg("text", title));
    lines.push("");

    items.forEach((item, index) => {
      const isCursor = index === cursor && !noteMode;
      const box = checked.has(index) ? "[x]" : "[ ]";
      const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
      const color = isCursor ? "accent" : checked.has(index) ? "text" : "muted";
      addWrapped(prefix, theme.fg(color, `${box} ${item.path}`));
      if (item.description) {
        addWrapped("      ", theme.fg("muted", item.description));
      }
    });

    lines.push("");
    if (noteMode) {
      addWrapped(" ", theme.fg("muted", "Anything else to add? (empty is fine)"));
      for (const line of editor.render(Math.max(1, renderWidth - 2))) {
        lines.push(` ${line}`);
      }
      lines.push("");
      addWrapped(" ", theme.fg("dim", "Enter to finish • Esc to go back"));
    } else {
      addWrapped(
        " ",
        theme.fg(
          "dim",
          `↑↓ move • Space toggle • a all • Enter confirm (${checked.size} selected) • Esc cancel`,
        ),
      );
    }
    lines.push(theme.fg("accent", "─".repeat(renderWidth)));

    cachedLines = lines;
    return lines;
  }

  return {
    render,
    invalidate: () => {
      cachedLines = undefined;
    },
    handleInput,
  };
}

/* -------------------------------------------------------------------- exports */

const ScanParams = Type.Object({
  keywords: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Terms drawn from the user's stated scenario, used as a lexical prefilter.",
    }),
  ),
  sources: Type.Optional(
    Type.Array(Type.String(), {
      description: `Session stores to read: ${sourceIds().join(", ")}. Defaults to ${DEFAULT_SOURCE_IDS.join(", ")}. Ask the user before including anything else.`,
    }),
  ),
  roots: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Extra sessions roots to read as Pi-format transcripts, for a directory the user names by hand.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Restrict to these workspace paths and return their full transcript file lists. Use this after the user has chosen, to find the files to analyze.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: `Max workspaces to return (default ${DEFAULT_LIMIT}).` }),
  ),
});

const ChooseParams = Type.Object({
  title: Type.Optional(Type.String({ description: "Heading shown above the list." })),
  items: Type.Array(
    Type.Object({
      path: Type.String({ description: "Workspace path from scan_workspaces." }),
      description: Type.Optional(
        Type.String({ description: "Your one-line description of this workspace." }),
      ),
    }),
    { description: "Candidates in the order you want them shown, best first." },
  ),
  allow_notes: Type.Optional(
    Type.Boolean({ description: "Ask for free-text notes after selecting (default true)." }),
  ),
});

/* --------------------------------------------- AskUserQuestion (ported from Pi) */

const AskOptionSchema = Type.Object(
  {
    label: Type.String({
      minLength: 1,
      description:
        "Short display text for this option (1-5 words). If you recommend this option, make it the first option and append '(Recommended)' to the label.",
    }),
    description: Type.Optional(
      Type.String({
        description:
          "Optional explanation of what this option means or what happens if chosen -- trade-offs, implications, or a one-line rationale. Shown as a muted second line under the label.",
      }),
    ),
  },
  { additionalProperties: false },
);

const AskQuestionSchema = Type.Object(
  {
    header: Type.Optional(
      Type.String({ description: "Optional short heading shown above the question." }),
    ),
    question: Type.String({ description: "Question to ask the user." }),
    options: Type.Optional(
      Type.Array(AskOptionSchema, {
        minItems: 1,
        description:
          "Suggested choices, each with a short label and optional description. An `Other` row with a free-text field is always appended, so the user is never trapped inside the options you thought of. Omit this entirely when you want a description rather than a choice.",
      }),
    ),
    allowMultiple: Type.Optional(
      Type.Boolean({ description: "Whether the user may choose more than one option." }),
    ),
    placeholder: Type.Optional(
      Type.String({
        description:
          "Optional hint shown under the `Other` row, or under the field when there are no options.",
      }),
    ),
  },
  { additionalProperties: false },
);

const AskParams = Type.Object(
  {
    questions: Type.Array(AskQuestionSchema, {
      minItems: 1,
      maxItems: 4,
      description: "One to four user questions to ask sequentially.",
    }),
  },
  { additionalProperties: false },
);

function formatAnswers(answers) {
  const lines = ["User answers:"];
  for (const item of answers) lines.push(`- ${item.question}: ${item.answer}`);
  lines.push("", JSON.stringify({ answers }, null, 2));
  return lines.join("\n");
}

export default function harnessRsi(pi: ExtensionAPI) {
  let booted = false;

  pi.registerTool({
    name: "scan_workspaces",
    label: "Scan workspaces",
    description: `Group session history by working directory across the session stores the user has: ${SESSION_SOURCES.map((source) => `${source.id} (${source.label})`).join(", ")}. Returns raw facts per workspace -- path, which sources contributed, session count, bytes, date span, and excerpts of the user's own opening prompts. Ranking and descriptions are yours to write. Reads are head-bounded and no transcript body is returned. Pass \`paths\` after the user has chosen to get the full transcript file list for those workspaces.`,
    parameters: ScanParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await scanWorkspaces({
        keywords: params.keywords ?? [],
        sources: params.sources ?? DEFAULT_SOURCE_IDS,
        roots: params.roots ?? [],
        paths: params.paths ?? [],
        limit: params.limit ?? DEFAULT_LIMIT,
      });
      const missing = result.sources_scanned
        .filter((source) => !source.available)
        .map((source) => source.id);
      const hints: string[] = [];
      if (result.unknown_sources.length > 0) {
        hints.push(
          `Unknown source ids ignored: ${result.unknown_sources.join(", ")}. Valid ids are ${sourceIds().join(", ")}.`,
        );
      }
      if (missing.length > 0) {
        hints.push(`No store on disk for: ${missing.join(", ")}.`);
      }
      if (result.workspaces_found === 0) {
        hints.push(
          `No session history found in the requested sources. Tell the user plainly, then ask whether to include others (${sourceIds().join(", ")}) or a directory they name.`,
        );
      }
      const hint = hints.length > 0 ? `\n\n${hints.join(" ")}` : "";
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) + hint }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "choose_workspaces",
    label: "Choose workspaces",
    description:
      "Show the user a multi-select page of candidate workspaces and return the ones they pick plus any notes they add. Call this after you have ranked the scan results and written a description for each candidate.",
    parameters: ChooseParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const items: ChoiceItem[] = (params.items ?? []).filter(
        (item) => item && typeof item.path === "string" && item.path.trim() !== "",
      );
      if (items.length === 0) {
        return {
          content: [{ type: "text", text: "No candidates were supplied." }],
          details: { selected: [], notes: "", cancelled: true },
        };
      }
      if (ctx.mode !== "tui") {
        // No keyboard focus available: be explicit rather than silently
        // pretending the user chose everything.
        const details = {
          selected: items.map((item) => item.path),
          notes: "",
          cancelled: false,
          interactive: false,
        };
        return {
          content: [
            {
              type: "text",
              text: `Interactive selection is unavailable in ${ctx.mode} mode, so all ${items.length} candidates are included by default. Say so before relying on this.\n${JSON.stringify(details, null, 2)}`,
            },
          ],
          details,
        };
      }

      const title = params.title ?? "Which workspaces should inform this Genome?";
      const allowNotes = params.allow_notes !== false;
      const result = await ctx.ui.custom<ChoiceResult | null>(
        (tui, theme, _keybindings, done) =>
          renderSelector(tui, theme, done, { title, items, allowNotes }),
        { overlay: false },
      );

      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: "The user cancelled the selection. Ask what they want to do instead; do not pick for them.",
            },
          ],
          details: { selected: [], notes: "", cancelled: true },
        };
      }
      const details = { ...result, cancelled: false, interactive: true };
      return {
        content: [
          {
            type: "text",
            text: [
              `Selected ${result.selected.length} of ${items.length} workspaces:`,
              ...result.selected.map((path) => `- ${path}`),
              result.notes ? `\nUser notes: ${result.notes}` : "\nUser added no notes.",
            ].join("\n"),
          },
        ],
        details,
      };
    },
  });

  // Pi's own clarification dialog. Upstream this is a core built-in; the
  // released package does not ship it, so the Genome carries it rather than
  // depending on a fork.
  pi.registerTool({
    name: "AskUserQuestion",
    label: "AskUserQuestion",
    description:
      "Ask the user one or more focused clarification questions. Supports suggested options, multi-select, and a free-text fallback.",
    promptSnippet:
      "Ask the user focused clarification questions and receive structured answers",
    promptGuidelines: [
      "Use AskUserQuestion whenever a user choice would materially change the Genome you produce.",
      "Prefer AskUserQuestion over making avoidable assumptions.",
      "Keep questions specific and actionable. Prefer options when the decision can be bounded, but still allow the user to answer freely when needed.",
      "Keep option labels to 1-5 words; use the option description to explain trade-offs, implications, or a one-line rationale.",
      "If you recommend a specific option, put it first and append '(Recommended)' to its label.",
    ],
    parameters: AskParams,
    executionMode: "sequential",
    // Tolerate plain-string option lists from older callers.
    prepareArguments: (args) => ({
      questions: (args?.questions ?? []).map((item) =>
        Array.isArray(item.options) &&
        item.options.every((option) => typeof option === "string")
          ? { ...item, options: item.options.map((label) => ({ label })) }
          : item,
      ),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("AskUserQuestion requires an interactive UI session");
      }
      const result = await ctx.ui.custom<AskUserQuestionDialogResult | undefined>(
        (tui, theme, _keybindings, done) =>
          new AskUserQuestionDialog(input.questions, theme, done, tui),
      );
      if (!result) throw new Error("User cancelled AskUserQuestion");

      if (result.type === "chat") {
        const asked = input.questions.map((q) => `- "${q.question}"`).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `The user chose to chat about this instead of answering the questions. Ask them what they would like to clarify, then reformulate your questions if appropriate.\n\nQuestions asked:\n${asked}`,
            },
          ],
          details: { type: "chat" },
        };
      }
      return {
        content: [{ type: "text", text: formatAnswers(result.answers) }],
        details: { type: "answers", answers: result.answers },
      };
    },
  });

  /**
   * Ask the first question without making the user type first. The behaviour is
   * defined by the Genome's system prompt; this only starts the turn.
   */
  function boot(ctx, force = false) {
    if (booted && !force) return;
    booted = true;
    try {
      pi.sendMessage(
        {
          customType: "harness-rsi.boot",
          content: BOOT_PROMPT,
          display: false,
        },
        { triggerTurn: true },
      );
    } catch (error) {
      // Never take the session down over a convenience nudge.
      ctx.ui.notify(
        `harness-rsi could not start automatically (${error instanceof Error ? error.message : String(error)}). Run /genome-new to begin.`,
        "warning",
      );
    }
  }

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!["startup", "new"].includes(event.reason)) return;
    // A resumed or already-started conversation must not be interrupted.
    const hasHistory = ctx.sessionManager
      .getEntries()
      .some((entry) => entry.type === "message");
    if (hasHistory) {
      booted = true;
      return;
    }
    // Defer so the TUI is mounted before the first turn begins.
    setTimeout(() => boot(ctx), 0);
  });

  pi.registerCommand("genome-new", {
    description: "Start (or restart) the Genome authoring flow.",
    async handler(args, ctx) {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current turn to finish.", "warning");
        return;
      }
      const scenario = args.trim();
      if (scenario) {
        pi.sendUserMessage(
          `Build a Genome for this scenario: ${scenario}\n\nStart at step 2 of the required sequence, unless that is only a label -- then ask for the specifics first.`,
        );
        booted = true;
        return;
      }
      boot(ctx, true);
    },
  });
}
