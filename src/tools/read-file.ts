import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  name: "read-file",
  description:
    "Read the contents of a file. Returns the file content as text. Use this to inspect source code, configuration files, or any text file.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file to read",
      },
    },
    required: ["path"],
  },
};

export async function handler(
  input: Record<string, unknown>,
): Promise<string> {
  const path = input.path as string;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return `Error: File not found: ${path}`;
    }
    return await file.text();
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}
