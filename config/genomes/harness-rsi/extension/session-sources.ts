/**
 * Session readers for the harnesses a user actually arrives with.
 *
 * Almost nobody has RSIH history on the day they first run this Genome, so the
 * evidence has to come from wherever they have been working. Four stores are
 * supported today:
 *
 *   rsih    <agentDir>/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl
 *   pi      ~/.pi/agent/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl
 *   claude  ~/.claude/projects/<encoded cwd>/<uuid>.jsonl
 *   codex   $CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl (+ archived_sessions)
 *
 * RSIH and Pi share a schema. Claude Code's differs enough to need its own
 * reader but is shaped the same way: a JSONL file per session under a directory
 * named after the working directory.
 *
 * Adding another harness means adding one entry to `SESSION_SOURCES` with its
 * own reader; nothing else in the scan path is format-aware.
 *
 * Every read is bounded. These stores get large -- the Pi store on the machine
 * this was written against held 117 MB across 152 sessions -- so transcripts are
 * sampled from their heads. Pi and Claude use 64 KiB; Codex uses 2 MiB because
 * injected context can precede the first real user turn. Limits and malformed
 * records are reported rather than presented as complete evidence.
 *
 * No model calls happen here, and no transcript body is returned to the caller.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Head window for a transcript we have to parse ourselves. */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;
const CODEX_HEAD_BYTES = 2 * 1024 * 1024;
/** Prompts retained per session. Enough to characterise it, bounded for memory. */
const MAX_PROMPTS = 40;
/** Characters retained per prompt. */
const MAX_PROMPT_CHARS = 600;

const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

export type SamplingIssue =
  | "byte_limit"
  | "prompt_limit"
  | "prompt_truncated"
  | "malformed_json"
  | "read_error"
  | "no_user_events";

export interface SessionRecord {
  /** Source id: one of SESSION_SOURCES, or `custom` for a user-named root. */
  source: string;
  path: string;
  /** Working directory the session ran in. */
  cwd: string;
  bytes: number;
  created: Date;
  modified: Date;
  /** The user's own turns, truncated and capped. */
  prompts: string[];
  /** True when all text prompts were read and retained without truncation. */
  promptsComplete: boolean;
  samplingIssues: SamplingIssue[];
}

export interface SourceScan {
  id: string;
  label: string;
  roots: string[];
  available: boolean;
  sessions: number;
  skippedFiles: number;
}

export interface ScanResult {
  sources: SourceScan[];
  records: SessionRecord[];
  unknownSources: string[];
  skippedFiles: number;
}

interface ReadContext {
  seen: Set<string>;
  skippedFiles: number;
}

function readContext(): ReadContext {
  return { seen: new Set(), skippedFiles: 0 };
}

/* ------------------------------------------------------------------ plumbing */

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Read at most `bytes` from a regular file, closing it even on errors. */
function readHead(path: string, bytes: number) {
  let fd;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.allocUnsafe(Math.min(bytes, stat.size));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return {
      text: buffer.subarray(0, read).toString("utf8"),
      complete: read === fstatSync(fd).size,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Transcript files under a root, depth-bounded. */
function transcriptFiles(root: string, depth: number, compressed = false): string[] {
  if (depth < 0 || !existsSync(root) || !isDirectory(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const path = join(root, name);
    if (name.endsWith(".jsonl") || (compressed && name.endsWith(".jsonl.zst"))) {
      files.push(path);
    } else if (isDirectory(path)) {
      files.push(...transcriptFiles(path, depth - 1, compressed));
    }
  }
  return files;
}

function readTranscriptHead(path: string, bytes = TRANSCRIPT_HEAD_BYTES) {
  const head = readHead(path, bytes);
  const issues = new Set<SamplingIssue>();
  const entries: any[] = [];
  if (!head) {
    issues.add("read_error");
    return { entries, issues, text: "" };
  }
  let text = head.text;
  if (!head.complete) {
    issues.add("byte_limit");
    // Never interpret a line cut by the byte window (including mid-UTF-8).
    text = text.slice(0, text.lastIndexOf("\n") + 1);
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) entries.push(entry);
      else issues.add("malformed_json");
    } catch {
      issues.add("malformed_json");
    }
  }
  return { entries, issues, text: head.text };
}

function clean(text: unknown) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  return flat;
}

function push(prompts: string[], text: unknown, issues: Set<SamplingIssue>) {
  const value = clean(text);
  if (!value) return;
  if (prompts.length >= MAX_PROMPTS) {
    issues.add("prompt_limit");
    return;
  }
  if (value.length > MAX_PROMPT_CHARS) issues.add("prompt_truncated");
  prompts.push(value.length > MAX_PROMPT_CHARS ? `${value.slice(0, MAX_PROMPT_CHARS)}...` : value);
}

function fileStat(path: string) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return { bytes: stat.size, modified: stat.mtime, created: stat.birthtime ?? stat.mtime };
  } catch {
    return undefined;
  }
}

function timestamp(value: unknown, fallback: Date) {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

function extractCwd(head: string) {
  const match = CWD_FIELD.exec(head);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

/* ------------------------------------------------------- Pi / RSIH transcripts */

/** Text the user actually typed, ignoring tool results and other content parts. */
function piUserText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function readPiTranscript(path: string, source: string): SessionRecord | undefined {
  const stat = fileStat(path);
  if (!stat) return undefined;
  const { entries, issues, text } = readTranscriptHead(path);
  const meta = entries.find((entry) => entry.type === "session");
  const cwd = meta?.cwd ?? extractCwd(text);
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    push(prompts, piUserText(entry.message.content), issues);
  }
  return {
    source,
    path,
    cwd,
    bytes: stat.bytes,
    created: timestamp(meta?.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    promptsComplete: issues.size === 0,
    samplingIssues: [...issues],
  };
}

function readStore(
  roots: string[],
  source: string,
  reader: (path: string, source: string) => SessionRecord | undefined,
  depth: number,
  context = readContext(),
) {
  const records: SessionRecord[] = [];
  for (const root of roots) {
    for (const file of transcriptFiles(root, depth, source === "codex")) {
      let identity: string;
      try {
        identity = realpathSync(file);
      } catch {
        context.skippedFiles += 1;
        continue;
      }
      if (context.seen.has(identity)) continue;
      context.seen.add(identity);
      // Compressed Codex rollouts are outside this reader's supported format.
      const record = file.endsWith(".jsonl.zst") ? undefined : reader(file, source);
      if (record) {
        records.push(record);
      } else {
        context.skippedFiles += 1;
      }
    }
  }
  return records;
}

function readPiStore(roots: string[], source: string, context = readContext()) {
  return readStore(roots, source, readPiTranscript, 2, context);
}

/* ------------------------------------------------- Claude Code transcripts */

/**
 * True for a turn the user actually typed.
 *
 * Claude Code puts tool results, slash-command echoes and local command output
 * in `user` entries too. `promptSource` separates them outright, but it is not
 * present in transcripts written by older versions, so fall back to the shape:
 * genuine input is a plain string, and every machine-generated variant opens
 * with a wrapper tag (`<command-name>`, `<local-command-stdout>`, ...).
 */
function isClaudeTypedTurn(entry: any) {
  if (entry.type !== "user" || entry.isMeta === true) return false;
  const content = entry.message?.content;
  if (typeof content !== "string") return false;
  if (typeof entry.promptSource === "string") return entry.promptSource === "typed";
  return !content.trimStart().startsWith("<");
}

function readClaudeTranscript(path: string, source: string): SessionRecord | undefined {
  const stat = fileStat(path);
  if (!stat) return undefined;
  const { entries, issues, text } = readTranscriptHead(path);
  // The encoded directory name is lossy for paths that already contain dashes,
  // so take the cwd the entries carry.
  const located = entries.find((entry) => typeof entry.cwd === "string" && entry.cwd);
  const cwd = located?.cwd ?? extractCwd(text);
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const prompts: string[] = [];
  let first;
  for (const entry of entries) {
    if (!isClaudeTypedTurn(entry)) continue;
    first ??= entry.timestamp;
    push(prompts, entry.message.content, issues);
  }
  return {
    source,
    path,
    cwd,
    bytes: stat.bytes,
    created: timestamp(first ?? located?.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    promptsComplete: issues.size === 0,
    samplingIssues: [...issues],
  };
}

function readClaudeStore(roots: string[], source: string, context = readContext()) {
  return readStore(roots, source, readClaudeTranscript, 2, context);
}

/* ---------------------------------------------------------- Codex rollouts */

function readCodexTranscript(path: string, source: string): SessionRecord | undefined {
  const stat = fileStat(path);
  if (!stat) return undefined;
  const { entries, issues } = readTranscriptHead(path, CODEX_HEAD_BYTES);
  const meta = entries.find((entry) => entry.type === "session_meta")?.payload;
  if (typeof meta?.cwd !== "string" || !meta.cwd.trim()) return undefined;
  // Subagents and internal threads receive machine-generated tasks; these are
  // not independent evidence of the human user's habits.
  if (
    meta.source === "subagent" || meta.source === "internal" ||
    (meta.source && typeof meta.source === "object" &&
      ("subagent" in meta.source || "internal" in meta.source)) ||
    (typeof meta.thread_source === "string" && meta.thread_source !== "user")
  ) return undefined;

  const prompts: string[] = [];
  let userEvents = false;
  let responseUser = false;
  for (const entry of entries) {
    const payload = entry.payload;
    if (entry.type === "response_item" && payload?.role === "user") responseUser = true;
    if (entry.type !== "event_msg" || payload?.type !== "user_message") continue;
    userEvents = true;
    if (typeof payload.message !== "string") {
      issues.add("malformed_json");
      continue;
    }
    // response_item mirrors can contain injected AGENTS.md/environment text.
    // Only the explicit user event is evidence; repeated real requests stay.
    push(prompts, payload.message, issues);
  }
  if (responseUser && !userEvents) issues.add("no_user_events");
  return {
    source,
    path,
    cwd: meta.cwd,
    bytes: stat.bytes,
    created: timestamp(meta.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    promptsComplete: issues.size === 0,
    samplingIssues: [...issues],
  };
}

/* --------------------------------------------------------------------- sources */

interface SourceDefinition {
  id: string;
  label: string;
  roots: () => string[];
  read: (roots: string[], context?: ReadContext) => SessionRecord[];
}

/**
 * `rsih` is first because it is the only store this tool owns. The others are
 * here because they are why someone can use this Genome on day one, before they
 * have any RSIH history at all.
 */
export const SESSION_SOURCES: readonly SourceDefinition[] = Object.freeze([
  {
    id: "rsih",
    label: "RSIH",
    roots: () => [join(getAgentDir(), "sessions")],
    read: (roots, context) => readPiStore(roots, "rsih", context),
  },
  {
    id: "pi",
    label: "Pi",
    roots: () => [join(homedir(), ".pi", "agent", "sessions")],
    read: (roots, context) => readPiStore(roots, "pi", context),
  },
  {
    id: "claude",
    label: "Claude Code",
    roots: () => [join(homedir(), ".claude", "projects")],
    read: (roots, context) => readClaudeStore(roots, "claude", context),
  },
  {
    id: "codex",
    label: "Codex",
    roots: () => {
      const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
      return [join(home, "sessions"), join(home, "archived_sessions")];
    },
    read: (roots, context) => readStore(roots, "codex", readCodexTranscript, 3, context),
  },
]);

export const DEFAULT_SOURCE_IDS = Object.freeze(["rsih"]);

export function sourceIds() {
  return SESSION_SOURCES.map((source) => source.id);
}

/**
 * Read the requested sources. Unknown ids are reported rather than ignored, so a
 * typo does not look like an empty history.
 */
export function readSessions(
  requested: readonly string[] = DEFAULT_SOURCE_IDS,
  extraRoots: readonly string[] = [],
): ScanResult {
  const wanted = new Set(requested.map((id) => String(id).toLowerCase().trim()));
  const known = new Set(sourceIds());
  const unknownSources = [...wanted].filter((id) => !known.has(id));

  const sources: SourceScan[] = [];
  const records: SessionRecord[] = [];
  const context = readContext();
  for (const source of SESSION_SOURCES) {
    if (!wanted.has(source.id)) continue;
    const roots = source.roots();
    const available = roots.some(isDirectory);
    const previousSkipped = context.skippedFiles;
    const found = available ? source.read(roots, context) : [];
    records.push(...found);
    sources.push({
      id: source.id,
      label: source.label,
      roots,
      available,
      sessions: found.length,
      skippedFiles: context.skippedFiles - previousSkipped,
    });
  }

  // Known stores claim a file before custom roots, so aliases do not relabel it
  // as custom or inflate either the workspace's session count or its evidence.
  records.push(...readPiStore([...extraRoots], "custom", context));
  return { sources, records, unknownSources, skippedFiles: context.skippedFiles };
}

/** Extra sessions roots the user names by hand, read as Pi-format transcripts. */
export function readExtraRoots(roots: readonly string[]) {
  return readPiStore([...roots], "custom");
}
