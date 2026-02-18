import type { ToolDefinition } from "../types.ts";

const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB

export const definition: ToolDefinition = {
  name: "bash",
  description:
    "Execute a shell command and return its stdout and stderr. Use this for running build commands, installing packages, running tests, or any other shell operation.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      cwd: {
        type: "string",
        description: "Working directory for the command (optional)",
      },
    },
    required: ["command"],
  },
};

/**
 * Create a handler bound to a default working directory.
 */
export function createHandler(defaultCwd: string) {
  return (input: Record<string, unknown>) => handler(input, defaultCwd);
}

export async function handler(
  input: Record<string, unknown>,
  defaultCwd?: string,
): Promise<string> {
  const command = input.command as string;
  const cwd = (input.cwd as string | undefined) || defaultCwd;

  const args = cwd
    ? Bun.$`bash -c ${command}`.cwd(cwd).nothrow().quiet()
    : Bun.$`bash -c ${command}`.nothrow().quiet();

  const result = await args;

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  const exitCode = result.exitCode;

  let output = "";
  if (stdout) output += stdout;
  if (stderr) output += (output ? "\n" : "") + `[stderr]\n${stderr}`;
  output += `\n[exit code: ${exitCode}]`;

  // Truncate if too large
  if (output.length > MAX_OUTPUT_BYTES) {
    const half = Math.floor(MAX_OUTPUT_BYTES / 2);
    const omitted = output.length - MAX_OUTPUT_BYTES;
    output =
      output.slice(0, half) +
      `\n\n[... ${omitted} characters omitted ...]\n\n` +
      output.slice(-half);
  }

  return output;
}
