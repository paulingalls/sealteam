import type { ToolDefinition } from "../types.ts";

/**
 * Web fetch is a Claude server-side tool.
 * It is not executed locally — the tool registry passes it through
 * to the Claude API as { type: "web_fetch_20250910", name: "web_fetch" }.
 */
export const definition: ToolDefinition = {
  name: "web-fetch",
  description:
    "Fetch the contents of a URL. This is handled by Claude's built-in web fetch capability.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

export const serverTool = {
  type: "web_fetch_20250910" as const,
  name: "web_fetch" as const,
};

export async function handler(
  _input: Record<string, unknown>,
): Promise<string> {
  throw new Error(
    "web-fetch is a server-side tool and should not be called locally. " +
      "It is handled by the Claude API directly.",
  );
}
