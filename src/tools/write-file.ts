import { resolve } from "node:path";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  name: "write-file",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

/**
 * Create a handler bound to a default working directory.
 * Relative paths are resolved against workDir.
 */
export function createHandler(workDir: string) {
  return (input: Record<string, unknown>) => handler(input, workDir);
}

export async function handler(
  input: Record<string, unknown>,
  workDir?: string,
): Promise<string> {
  let path = input.path as string;
  if (workDir && !path.startsWith("/")) {
    path = resolve(workDir, path);
  }
  const content = input.content as string;
  try {
    // Ensure parent directory exists
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      await Bun.$`mkdir -p ${dir}`.quiet();
    }
    await Bun.write(path, content);
    return `Successfully wrote ${content.length} characters to ${path}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}
