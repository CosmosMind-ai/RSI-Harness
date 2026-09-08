import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Genome `generated_tools` run as sandboxed POSIX sh scripts. Pi owns every
 * built-in tool (read, ls, grep, find, write, edit, bash, powershell); RSIH
 * never reimplements them.
 */
export function createGeneratedTools({ cwd, genome }) {
  return (genome.generated_tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    async execute(args, { signal } = {}) {
      const result = await execFileAsync(
        tool.container_script.entrypoint ?? "/bin/sh",
        ["-c", tool.container_script.script],
        {
          cwd,
          env: {
            ...process.env,
            HARNESS_TOOL_ARGS: JSON.stringify(args),
          },
          timeout: tool.timeout_ms ?? 60000,
          maxBuffer: tool.max_output_chars ?? 20000,
          signal,
        },
      );
      return [result.stdout, result.stderr].filter(Boolean).join("\n");
    },
  }));
}
