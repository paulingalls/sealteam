import type { ToolDefinition } from "../types.ts";

/**
 * Web search is a Claude server-side tool.
 * It is not executed locally — the tool registry passes it through
 * to the Claude API as { type: "web_search_20250305", name: "web_search" }.
 */
export const definition: ToolDefinition = {
  name: "web-search",
  description:
    "Search the web for information. This is handled by Claude's built-in web search capability.",
  input_schema: {
    type: "object",
    properties: {},
  },
};

export const serverTool = {
  type: "web_search_20250305" as const,
  name: "web_search" as const,
};

export async function handler(
  _input: Record<string, unknown>,
): Promise<string> {
  throw new Error(
    "web-search is a server-side tool and should not be called locally. " +
      "It is handled by the Claude API directly.",
  );
}
