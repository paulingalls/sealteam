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

export async function handler(
  input: Record<string, unknown>,
): Promise<string> {
  const path = input.path as string;
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
