import type { ToolDefinition } from "../types.ts";
import { gitExec } from "../git-manager.ts";

export const definition: ToolDefinition = {
  name: "git",
  description:
    "Execute a git command in the agent's working directory. Use this for version control operations like commit, status, log, diff, add, etc.",
  input_schema: {
    type: "object",
    properties: {
      args: {
        type: "string",
        description:
          'The git subcommand and arguments (e.g. "status", "add -A", "commit -m \'message\'")',
      },
    },
    required: ["args"],
  },
};

/**
 * Create a handler bound to a specific working directory.
 * Called by the tool registry when setting up tools for an agent.
 */
export function createHandler(workDir: string) {
  return async (input: Record<string, unknown>): Promise<string> => {
    const args = input.args as string;
    // Split respecting quoted strings
    const parts = parseArgs(args);
    const result = await gitExec(workDir, parts);

    let output = "";
    if (result.stdout) output += result.stdout;
    if (result.stderr)
      output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
    output += `\n[exit code: ${result.exitCode}]`;
    return output;
  };
}

/**
 * Default handler — requires workDir to be set via context.
 * Falls back to cwd if no workDir is provided.
 */
export async function handler(
  input: Record<string, unknown>,
): Promise<string> {
  const workDir = (input._workDir as string) || process.cwd();
  const args = input.args as string;
  const parts = parseArgs(args);
  const result = await gitExec(workDir, parts);

  let output = "";
  if (result.stdout) output += result.stdout;
  if (result.stderr)
    output += (output ? "\n" : "") + `[stderr]\n${result.stderr}`;
  output += `\n[exit code: ${result.exitCode}]`;
  return output;
}

/** Simple argument parser that respects single and double quotes. */
function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
