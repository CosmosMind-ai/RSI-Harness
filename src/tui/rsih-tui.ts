import type {
  CustomEditor,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor as PiCustomEditor } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import type {
  Component,
  EditorTheme,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface RsiHeaderOptions {
  cwd: string;
  model: string;
  genome: string;
  version: string;
  resources?: {
    skills: string[];
    extensions: string[];
  };
}

type DnaPixel = "rail" | "rung" | "joint" | undefined;

const DNA_PIXEL_WIDTH = 18;
const DNA_PIXEL_HEIGHT = 18;
const DNA_RESET = "\u001b[39;49m";
const DNA_COLORS = {
  rail: { r: 236, g: 244, b: 255 },
  rung: { r: 34, g: 211, b: 238 },
  joint: { r: 192, g: 132, b: 252 },
} as const;

function dnaColor(
  pixel: Exclude<DnaPixel, undefined>,
  background = false,
): string {
  const { r, g, b } = DNA_COLORS[pixel];
  return `\u001b[${background ? 48 : 38};2;${r};${g};${b}m`;
}

function createDnaPixelGrid(): DnaPixel[][] {
  const grid: DnaPixel[][] = Array.from(
    { length: DNA_PIXEL_HEIGHT },
    () => Array<DnaPixel>(DNA_PIXEL_WIDTH).fill(undefined),
  );
  const setPixel = (x: number, y: number, pixel: Exclude<DnaPixel, undefined>) => {
    if (x >= 0 && x < DNA_PIXEL_WIDTH && y >= 0 && y < DNA_PIXEL_HEIGHT) {
      grid[y]![x] = pixel;
    }
  };

  const drawSegment = (
    from: [number, number],
    to: [number, number],
    pixel: "rung" | "rail",
  ) => {
    const distance = Math.max(
      Math.abs(to[0] - from[0]),
      Math.abs(to[1] - from[1]),
    );
    for (let i = 0; i <= distance; i += 1) {
      const progress = distance === 0 ? 0 : i / distance;
      const x = Math.round(from[0] + (to[0] - from[0]) * progress);
      const y = Math.round(from[1] + (to[1] - from[1]) * progress);
      if (pixel === "rail" && grid[y]?.[x] === "rung") {
        setPixel(x, y, "joint");
      } else if (!grid[y]?.[x]) {
        setPixel(x, y, pixel);
      }
    }
  };

  const center = (DNA_PIXEL_WIDTH - 1) / 2;
  const amplitude = 6;

  for (let y = 0; y < DNA_PIXEL_HEIGHT; y += 1) {
    const phase = (y / (DNA_PIXEL_HEIGHT - 1)) * Math.PI * 2;
    const left = Math.round(center - amplitude * Math.cos(phase));
    const right = Math.round(center + amplitude * Math.cos(phase));

    for (const x of [left, right]) {
      for (let offset = -1; offset <= 1; offset += 1) {
        setPixel(x + offset, y, "rail");
      }
    }

    if (y % 3 === 1 && left !== right) {
      const start = Math.min(left, right);
      const end = Math.max(left, right);
      for (let x = start; x <= end; x += 1) {
        grid[y]![x] = grid[y]![x] === "rail" ? "joint" : "rung";
      }
    }
  }

  return grid;
}

function renderDnaPixelPair(
  top: DnaPixel,
  bottom: DnaPixel,
): string {
  if (!top && !bottom) return " ";
  if (top && bottom && top === bottom) {
    return `${dnaColor(top)}█${DNA_RESET}`;
  }
  if (top && bottom) {
    return `${dnaColor(top)}${dnaColor(bottom, true)}▀${DNA_RESET}`;
  }
  if (top) return `${dnaColor(top)}▀${DNA_RESET}`;
  return `${dnaColor(bottom!)}▄${DNA_RESET}`;
}

function renderDnaLogo(): string[] {
  const grid = createDnaPixelGrid();
  const lines: string[] = [];
  for (let y = 0; y < DNA_PIXEL_HEIGHT; y += 2) {
    let line = "";
    for (let x = 0; x < DNA_PIXEL_WIDTH; x += 1) {
      line += renderDnaPixelPair(grid[y]![x], grid[y + 1]![x]);
    }
    lines.push(line);
  }
  return lines;
}

const DNA_LOGO = renderDnaLogo();

const purple = (text: string) => `\u001b[35m${text}\u001b[39m`;

function contentLine(content: string, width: number, color: (text: string) => string) {
  const innerWidth = Math.max(1, width - 4);
  const clipped = truncateToWidth(content, innerWidth, "");
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return `${color("│")} ${clipped}${padding} ${color("│")}`;
}

function padToWidth(content: string, width: number): string {
  return `${content}${" ".repeat(Math.max(0, width - visibleWidth(content)))}`;
}

function compactWorkspacePath(path: string, width: number): string {
  const home = homedir();
  const displayPath = path === home
    ? "~"
    : path.startsWith(`${home}/`)
      ? `~${path.slice(home.length)}`
      : path;
  if (visibleWidth(displayPath) <= width) return displayPath;

  const segments = displayPath.split("/").filter(Boolean);
  const marker = displayPath.startsWith("~") ? "~" : "";
  for (let count = Math.min(3, segments.length); count >= 1; count -= 1) {
    const suffix = segments.slice(-count).join("/");
    const compact = `${marker}/.../${suffix}`;
    if (visibleWidth(compact) <= width) return compact;
  }
  return truncateToWidth(`${marker}/.../`, Math.max(1, width), "…");
}

const MAX_RESOURCE_LINES = 3;

function resourceSectionRows(
  label: string,
  items: string[],
  width: number,
  color: (text: string) => string,
): string[] {
  const rows = [color(`[${label}]`)];
  if (items.length === 0) return rows;

  const itemLines: string[] = [];
  let current = "";
  for (const item of items) {
    const candidate = current ? `${current}, ${item}` : item;
    if (
      current &&
      visibleWidth(`  ${candidate}`) > width
    ) {
      itemLines.push(`  ${current}`);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current) itemLines.push(`  ${current}`);

  const visibleLines = itemLines.slice(0, MAX_RESOURCE_LINES);
  if (itemLines.length > MAX_RESOURCE_LINES) {
    const last = visibleLines.length - 1;
    visibleLines[last] = truncateToWidth(`${visibleLines[last]}…`, width, "…");
  }
  rows.push(...visibleLines);
  return rows;
}

export function rsiHeaderLines(
  width: number,
  options: RsiHeaderOptions,
  color: (text: string) => string,
  bold: (text: string) => string,
) {
  const safeWidth = Math.max(24, width);
  const horizontal = "─".repeat(Math.max(1, safeWidth - 2));
  const innerWidth = Math.max(1, safeWidth - 4);
  const logoWidth = Math.max(...DNA_LOGO.map((line) => visibleWidth(line)));
  const leftColumnWidth = Math.min(
    32,
    Math.max(28, logoWidth + 4, Math.floor(innerWidth * 0.3)),
  );
  const rightColumnWidth = Math.max(1, innerWidth - leftColumnWidth - 3);
  const resourceRows: string[] = [];
  if (options.resources) {
    resourceRows.push(
      ...resourceSectionRows(
        "Skills",
        options.resources.skills,
        rightColumnWidth,
        color,
      ),
      ...resourceSectionRows(
        "Extensions",
        options.resources.extensions,
        rightColumnWidth,
        color,
      ),
    );
  }
  const rightContent = [
    color(bold("Welcome to RSIH")),
    "A Genome-driven runtime for coding workflows",
    color("─".repeat(rightColumnWidth)),
    ...resourceRows,
  ];
  const leftContent = [
    ...DNA_LOGO,
    "",
    `Workspace: ${compactWorkspacePath(
      options.cwd,
      Math.max(1, leftColumnWidth - visibleWidth("Workspace: ")),
    )}`,
    `Model: ${options.model || "auto"}`,
    `Genome: ${options.genome}`,
    `Version: ${options.version}`,
  ];
  const rowCount = Math.max(leftContent.length, rightContent.length);
  const columns = Array.from({ length: rowCount }, (_, index) => {
    const left = truncateToWidth(leftContent[index] ?? "", leftColumnWidth, "");
    const right = truncateToWidth(rightContent[index] ?? "", rightColumnWidth, "");
    return contentLine(
      `${padToWidth(left, leftColumnWidth)} ${color("│")} ${padToWidth(right, rightColumnWidth)}`,
      safeWidth,
      color,
    );
  });
  const lines = [
    color(`╭${horizontal}╮`),
    ...columns,
    color(`╰${horizontal}╯`),
  ];
  return lines;
}

export class RsiHeader implements Component {
  private readonly theme: Theme;
  private readonly options: RsiHeaderOptions;

  constructor(theme: Theme, options: RsiHeaderOptions) {
    this.theme = theme;
    this.options = options;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return rsiHeaderLines(
      width,
      this.options,
      purple,
      (text) => this.theme.bold(text),
    );
  }
}

export class RsiEditor extends PiCustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
  ) {
    super(tui, theme, keybindings, { paddingX: 2 });
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length < 3) return lines;

    // Whatever Pi renders below the input -- the slash-command and file
    // autocomplete lists included -- stays where Pi puts it. Only the prompt
    // character is ours: replace one real padding cell when present, because
    // with zero padding the first byte is Pi's cursor marker and the TUI needs
    // it intact.
    const prompt = this.borderColor(">");
    const leadingPadding = lines[1]!.match(/^ */)?.[0].length ?? 0;
    if (leadingPadding > 0) {
      lines[1] = `${prompt}${lines[1]!.slice(1)}`;
    } else {
      // Zero-padding editors already consume the full row width. Truncate one
      // cell before adding the prompt so the custom row stays within `width`.
      lines[1] = `${prompt}${truncateToWidth(lines[1]!, Math.max(1, width - visibleWidth(prompt)), "")}`;
    }
    return lines;
  }
}

export function createRsiHeader(
  theme: Theme,
  options: RsiHeaderOptions,
): Component {
  return new RsiHeader(theme, options);
}

export function createRsiEditor(
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
): CustomEditor {
  return new RsiEditor(tui, theme, keybindings);
}
