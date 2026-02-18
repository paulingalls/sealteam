import type { ToolDefinition } from "../types.ts";
import type { ToolRegistry } from "../tool-registry.ts";

export const definition: ToolDefinition = {
  name: "create-tool",
  description:
    "Create a new reusable tool that persists across sessions. Write the tool source code (must export `definition` and `handler`) and test source code (using bun:test). The tool goes through validation (schema, security scan, test execution) before activation. Once active, it is available to all agents in the current and future sessions on this workspace.\n\nSECURITY RULES — your source will be rejected if it violates these:\n- ALLOWED imports: relative paths (./), bun, bun:test, node:path, node:url, node:crypto, node:buffer\n- FORBIDDEN imports: node:fs (use Bun.file() instead), node:child_process (use Bun.$`` instead), axios, express, or any npm package\n- FORBIDDEN patterns: eval(), new Function() (write explicit logic instead), process.env access (except process.env.ANTHROPIC_API_KEY)\n\nThe handler must return a string (use JSON.stringify() for structured data). Use Bun APIs: Bun.file() for file I/O, Bun.$`` for shell commands, fetch() for HTTP requests.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Tool name in kebab-case (e.g., 'read-gmail', 'parse-csv'). Must be unique.",
      },
      source: {
        type: "string",
        description:
          "Complete TypeScript source for the tool. Must export `definition: { name, description, input_schema }` and `handler: (input: Record<string, unknown>) => Promise<string>`. Only allowed imports: relative paths within tools/, bun, bun:test, node:path, node:url, node:crypto, node:buffer. No eval(), new Function(), or process.env (except ANTHROPIC_API_KEY).",
      },
      test_source: {
        type: "string",
        description:
          "Complete TypeScript test source using `bun:test`. Must import and test the tool's definition and handler. All tests must pass for the tool to be activated.",
      },
    },
    required: ["name", "source", "test_source"],
  },
};

export interface CreateToolContext {
  workspacePath: string;
  toolRegistry: ToolRegistry;
}

/**
 * Create a handler bound to a workspace and tool registry.
 */
export function createHandler(ctx: CreateToolContext) {
  return async (input: Record<string, unknown>): Promise<string> => {
    const name = input.name as string;
    const source = input.source as string;
    const testSource = input.test_source as string;

    // Basic input validation
    if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
      return `Error: Tool name must be kebab-case (lowercase letters, numbers, hyphens), starting with a letter. Got: "${name}"`;
    }

    if (!source || source.trim().length === 0) {
      return "Error: Tool source code is required.";
    }

    if (!testSource || testSource.trim().length === 0) {
      return "Error: Test source code is required.";
    }

    const toolPath = `${ctx.workspacePath}/tools/${name}.ts`;
    const testPath = `${ctx.workspacePath}/tools/${name}.test.ts`;

    try {
      // Ensure tools directory exists
      await Bun.$`mkdir -p ${ctx.workspacePath}/tools`.quiet();

      // Write tool source
      await Bun.write(toolPath, source);

      // Write test source
      await Bun.write(testPath, testSource);

      // Run validation pipeline (schema + security + tests)
      const result = await ctx.toolRegistry.validateDynamicTool(
        `tools/${name}.ts`,
        ctx.workspacePath,
      );

      if (result.valid) {
        return `Tool "${name}" created and activated successfully. It is now available for use by all agents. File: tools/${name}.ts`;
      } else {
        // Clean up failed tool files
        try {
          await Bun.$`rm -f ${toolPath} ${testPath}`.quiet();
        } catch {
          // Best effort cleanup
        }
        return `Tool "${name}" failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n\nFix the issues and try again. The tool files have been removed.`;
      }
    } catch (err) {
      // Clean up on unexpected error
      try {
        await Bun.$`rm -f ${toolPath} ${testPath}`.quiet();
      } catch {
        // Best effort cleanup
      }
      return `Error creating tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

/**
 * Default handler — requires bound context.
 */
export async function handler(
  _input: Record<string, unknown>,
): Promise<string> {
  throw new Error(
    "create-tool requires a bound handler created via createHandler(). " +
      "The tool registry should set this up with the workspace context.",
  );
}
