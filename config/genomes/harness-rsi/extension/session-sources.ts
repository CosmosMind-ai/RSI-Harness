/**
 * Session readers for the harnesses a user actually arrives with.
 *
 * Almost nobody has RSIH history on the day they first run this Genome, so the
 * evidence has to come from wherever they have been working. Three stores are
 * supported today:
 *
 *   rsih    <agentDir>/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl
 *   pi      ~/.pi/agent/sessions/--<encoded cwd>--/<ts>_<uuid>.jsonl
 *   claude  ~/.claude/projects/<encoded cwd>/<uuid>.jsonl
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
 * never read whole. Each file contributes its head only, which is where the cwd
 * and the opening user turns live. Measured on the same machine, Claude's first
 * real user turn sits 424 bytes in at the median and 1.4 KB in at the worst, so
 * the head window is not a practical limit for either format.
 *
 * No model calls happen here, and no transcript body is returned to the caller.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Head window for a transcript we have to parse ourselves. */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;
/** Smaller window for when only the `session` header is needed. */
const META_HEAD_BYTES = 16 * 1024;
/** Prompts retained per session. Enough to characterise it, bounded for memory. */
const MAX_PROMPTS = 40;
/** Characters retained per prompt. */
const MAX_PROMPT_CHARS = 600;

const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

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
  /** True when `prompts` is the complete set rather than a head sample. */
  promptsComplete: boolean;
}

export interface SourceScan {
  id: string;
  label: string;
  roots: string[];
  available: boolean;
  sessions: number;
}

export interface ScanResult {
  sources: SourceScan[];
  records: SessionRecord[];
  unknownSources: string[];
}

/* ------------------------------------------------------------------ plumbing */

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Read at most `bytes` from the start of a file. Never throws. */
function readHead(path: string, bytes: number) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    // A window can end mid-character; the trailing replacement character is
    // harmless because every consumer parses whole lines or matches a regex.
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Transcript files under a root, depth-bounded. */
function transcriptFiles(root: string, depth: number): string[] {
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
    if (name.endsWith(".jsonl")) {
      files.push(path);
    } else if (isDirectory(path)) {
      files.push(...transcriptFiles(path, depth - 1));
    }
  }
  return files;
}

function parseLines(text: string) {
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // The last line of a head window is usually truncated.
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      /* a line we cannot read tells us nothing */
    }
  }
  return entries;
}

function clean(text: unknown) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  return flat.length > MAX_PROMPT_CHARS ? `${flat.slice(0, MAX_PROMPT_CHARS)}...` : flat;
}

function push(prompts: string[], text: unknown) {
  if (prompts.length >= MAX_PROMPTS) return;
  const value = clean(text);
  if (value) prompts.push(value);
}

function fileStat(path: string) {
  try {
    const stat = statSync(path);
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
  const entries = parseLines(readHead(path, TRANSCRIPT_HEAD_BYTES));
  const meta = entries.find((entry) => entry.type === "session");
  const cwd = meta?.cwd ?? extractCwd(readHead(path, META_HEAD_BYTES));
  if (!cwd) return undefined;
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    push(prompts, piUserText(entry.message.content));
    if (prompts.length >= MAX_PROMPTS) break;
  }
  return {
    source,
    path,
    cwd,
    bytes: stat.bytes,
    created: timestamp(meta?.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    // The head window only reaches the opening turns of a long session.
    promptsComplete: stat.bytes <= TRANSCRIPT_HEAD_BYTES,
  };
}

function readPiStore(roots: string[], source: string) {
  const records: SessionRecord[] = [];
  for (const root of roots) {
    // `root/--encoded cwd--/*.jsonl`, and a root may itself be one such directory.
    for (const file of transcriptFiles(root, 2)) {
      const record = readPiTranscript(file, source);
      if (record) records.push(record);
    }
  }
  return records;
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
  const entries = parseLines(readHead(path, TRANSCRIPT_HEAD_BYTES));
  // The encoded directory name is lossy for paths that already contain dashes,
  // so take the cwd the entries carry.
  const located = entries.find((entry) => typeof entry.cwd === "string" && entry.cwd);
  const cwd = located?.cwd ?? extractCwd(readHead(path, META_HEAD_BYTES));
  if (!cwd) return undefined;
  const prompts: string[] = [];
  let first;
  for (const entry of entries) {
    if (!isClaudeTypedTurn(entry)) continue;
    first ??= entry.timestamp;
    push(prompts, entry.message.content);
    if (prompts.length >= MAX_PROMPTS) break;
  }
  return {
    source,
    path,
    cwd,
    bytes: stat.bytes,
    created: timestamp(first ?? located?.timestamp, stat.created),
    modified: stat.modified,
    prompts,
    promptsComplete: stat.bytes <= TRANSCRIPT_HEAD_BYTES,
  };
}

function readClaudeStore(roots: string[], source: string) {
  const records: SessionRecord[] = [];
  for (const root of roots) {
    for (const file of transcriptFiles(root, 2)) {
      const record = readClaudeTranscript(file, source);
      if (record) records.push(record);
    }
  }
  return records;
}

/* --------------------------------------------------------------------- sources */

interface SourceDefinition {
  id: string;
  label: string;
  roots: () => string[];
  read: (roots: string[]) => SessionRecord[];
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
    read: (roots) => readPiStore(roots, "rsih"),
  },
  {
    id: "pi",
    label: "Pi",
    roots: () => [join(homedir(), ".pi", "agent", "sessions")],
    read: (roots) => readPiStore(roots, "pi"),
  },
  {
    id: "claude",
    label: "Claude Code",
    roots: () => [join(homedir(), ".claude", "projects")],
    read: (roots) => readClaudeStore(roots, "claude"),
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
export function readSessions(requested: readonly string[] = DEFAULT_SOURCE_IDS): ScanResult {
  const wanted = new Set(requested.map((id) => String(id).toLowerCase().trim()));
  const known = new Set(sourceIds());
  const unknownSources = [...wanted].filter((id) => !known.has(id));

  const sources: SourceScan[] = [];
  const records: SessionRecord[] = [];
  for (const source of SESSION_SOURCES) {
    if (!wanted.has(source.id)) continue;
    const roots = source.roots();
    const available = roots.some((root) => existsSync(root));
    const found = available ? source.read(roots) : [];
    records.push(...found);
    sources.push({
      id: source.id,
      label: source.label,
      roots,
      available,
      sessions: found.length,
    });
  }

  return { sources, records, unknownSources };
}

/** Extra sessions roots the user names by hand, read as Pi-format transcripts. */
export function readExtraRoots(roots: readonly string[]) {
  return readPiStore([...roots], "custom");
}
