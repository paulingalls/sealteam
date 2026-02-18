import type {
  ToolDefinition,
  ToolModule,
  ToolRegistryEntry,
} from "./types.ts";
import type { ToolUnion } from "./claude-client.ts";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type { MessageQueue } from "./message-queue.ts";
import type { SpawnContext } from "./tools/spawn-agent.ts";

import * as bashTool from "./tools/bash.ts";
import * as readFileTool from "./tools/read-file.ts";
import * as writeFileTool from "./tools/write-file.ts";
import * as webSearchTool from "./tools/web-search.ts";
import * as webFetchTool from "./tools/web-fetch.ts";
import * as gitTool from "./tools/git.ts";
import * as sendMessageTool from "./tools/send-message.ts";
import * as spawnAgentTool from "./tools/spawn-agent.ts";

/** Names of tools that are handled server-side by the Claude API. */
const SERVER_TOOL_NAMES = new Set(["web-search", "web-fetch"]);

/** Patterns disallowed in dynamic tool source code, with descriptions. */
const DISALLOWED_PATTERNS: { pattern: RegExp; description: string }[] = [
  { pattern: /\beval\s*\(/, description: "eval()" },
  { pattern: /\bnew\s+Function\s*\(/, description: "new Function()" },
  { pattern: /\bprocess\.env\b(?!\.ANTHROPIC_API_KEY)/, description: "process.env access (only ANTHROPIC_API_KEY is allowed)" },
];

/** Import specifiers allowed in dynamic tools (beyond relative imports). */
const ALLOWED_IMPORT_PACKAGES = new Set([
  "bun",
  "bun:test",
  "node:path",
  "node:url",
  "node:crypto",
  "node:buffer",
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export class ToolRegistry {
  private builtinTools = new Map<string, ToolModule>();
  private dynamicTools = new Map<string, ToolModule>();

  /**
   * Load all built-in tools with default handlers.
   */
  loadBuiltins(): void {
    this.builtinTools.set("bash", bashTool);
    this.builtinTools.set("read-file", readFileTool);
    this.builtinTools.set("write-file", writeFileTool);
    this.builtinTools.set("web-search", webSearchTool);
    this.builtinTools.set("web-fetch", webFetchTool);
    this.builtinTools.set("git", gitTool);
    this.builtinTools.set("send-message", sendMessageTool);
    this.builtinTools.set("spawn-agent", spawnAgentTool);
  }

  /**
   * Bind context-dependent tools (git, send-message, spawn-agent) to
   * a specific agent's environment. Call this after loadBuiltins().
   */
  bindAgentContext(params: {
    agentName: string;
    workDir: string;
    messageQueue: MessageQueue;
    workspacePath: string;
    spawnContext?: SpawnContext;
  }): void {
    // Bind bash tool to agent's working directory
    this.builtinTools.set("bash", {
      definition: bashTool.definition,
      handler: bashTool.createHandler(params.workDir),
    });

    // Bind read-file to agent's working directory
    this.builtinTools.set("read-file", {
      definition: readFileTool.definition,
      handler: readFileTool.createHandler(params.workDir),
    });

    // Bind write-file to agent's working directory
    this.builtinTools.set("write-file", {
      definition: writeFileTool.definition,
      handler: writeFileTool.createHandler(params.workDir),
    });

    // Bind git tool to agent's working directory
    this.builtinTools.set("git", {
      definition: gitTool.definition,
      handler: gitTool.createHandler(params.workDir),
    });

    // Bind send-message to agent's name and queue
    this.builtinTools.set("send-message", {
      definition: sendMessageTool.definition,
      handler: sendMessageTool.createHandler(
        params.agentName,
        params.messageQueue,
        params.workspacePath,
      ),
    });

    // Bind spawn-agent if context provided (leader only)
    if (params.spawnContext) {
      this.builtinTools.set("spawn-agent", {
        definition: spawnAgentTool.definition,
        handler: spawnAgentTool.createHandler(params.spawnContext),
      });
    }
  }

  /**
   * Scan the workspace tools/ directory for dynamic tools.
   * Only loads tools marked "active" in registry.json.
   */
  async scanDynamic(workspacePath: string): Promise<void> {
    const registryPath = `${workspacePath}/tools/registry.json`;
    try {
      const text = await Bun.file(registryPath).text();
      const registry = JSON.parse(text) as { tools: ToolRegistryEntry[] };

      for (const entry of registry.tools) {
        if (entry.status !== "active") continue;
        if (this.dynamicTools.has(entry.name)) continue;

        try {
          const toolPath = `${workspacePath}/${entry.path}`;
          const mod = (await import(toolPath)) as ToolModule;
          if (mod.definition && typeof mod.handler === "function") {
            this.dynamicTools.set(entry.name, mod);
          }
        } catch {
          // Skip tools that fail to load
        }
      }
    } catch {
      // No registry.json yet — that's fine
    }
  }

  /**
   * Get Claude API tool definitions for a specific agent, filtered
   * by the agent's allowed tool list. Excludes server-side tools
   * (those are returned by getServerTools instead).
   */
  getToolDefinitions(toolNames: string[]): ToolUnion[] {
    const defs: ToolUnion[] = [];
    for (const name of toolNames) {
      if (SERVER_TOOL_NAMES.has(name)) continue;

      const tool =
        this.builtinTools.get(name) || this.dynamicTools.get(name);
      if (tool) {
        defs.push({
          name: tool.definition.name,
          description: tool.definition.description,
          input_schema: tool.definition.input_schema as Tool.InputSchema,
        });
      }
    }
    return defs;
  }

  /**
   * Get server-side tool specs for tools in the agent's allowed list.
   * These are passed directly to the Claude API request.
   */
  getServerTools(toolNames: string[]): ToolUnion[] {
    const tools: ToolUnion[] = [];
    for (const name of toolNames) {
      if (name === "web-search") {
        tools.push(webSearchTool.serverTool as unknown as ToolUnion);
      } else if (name === "web-fetch") {
        tools.push(webFetchTool.serverTool as unknown as ToolUnion);
      }
    }
    return tools;
  }

  /**
   * Get all tools for a Claude API call — local definitions + server tools.
   */
  getAllToolsForApi(toolNames: string[]): ToolUnion[] {
    return [
      ...this.getToolDefinitions(toolNames),
      ...this.getServerTools(toolNames),
    ];
  }

  /**
   * Execute a local tool handler by name.
   * Throws if the tool is server-side or not found.
   */
  async executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    if (SERVER_TOOL_NAMES.has(name)) {
      throw new Error(
        `"${name}" is a server-side tool and cannot be executed locally.`,
      );
    }

    const tool =
      this.builtinTools.get(name) || this.dynamicTools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    return tool.handler(input);
  }

  /**
   * Check if a tool name is a server-side tool.
   */
  isServerTool(name: string): boolean {
    return SERVER_TOOL_NAMES.has(name);
  }

  /**
   * List all available tool names (built-in + dynamic).
   */
  listTools(): string[] {
    return [
      ...this.builtinTools.keys(),
      ...this.dynamicTools.keys(),
    ];
  }

  /**
   * Validate a dynamic tool through the full pipeline:
   * 1. Schema validation (import and check exports)
   * 2. Security scan (disallowed patterns)
   * 3. Test coverage (test file must exist and pass)
   *
   * If valid, the tool is marked "active" in registry.json and loaded.
   * If invalid, it is marked "disabled" with the error.
   */
  async validateDynamicTool(
    toolPath: string,
    workspacePath: string,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const absoluteToolPath = toolPath.startsWith("/")
      ? toolPath
      : `${workspacePath}/${toolPath}`;

    // 1. Schema validation — import and check exports
    let mod: Record<string, unknown>;
    try {
      mod = await import(absoluteToolPath);
    } catch (err) {
      errors.push(`Failed to import tool: ${err instanceof Error ? err.message : String(err)}`);
      await this.updateRegistryEntry(workspacePath, toolPath, "disabled", errors.join("; "));
      return { valid: false, errors };
    }

    const schemaErrors = validateToolSchema(mod);
    if (schemaErrors.length > 0) {
      errors.push(...schemaErrors);
      await this.updateRegistryEntry(workspacePath, toolPath, "disabled", errors.join("; "));
      return { valid: false, errors };
    }

    const definition = mod.definition as ToolDefinition;

    // 2. Security scan — check source code for disallowed patterns
    const securityErrors = await scanToolSecurity(absoluteToolPath, workspacePath);
    if (securityErrors.length > 0) {
      errors.push(...securityErrors);
      await this.updateRegistryEntry(workspacePath, toolPath, "disabled", errors.join("; "));
      return { valid: false, errors };
    }

    // 3. Test coverage — test file must exist and pass
    const testErrors = await checkTestCoverage(absoluteToolPath);
    if (testErrors.length > 0) {
      errors.push(...testErrors);
      await this.updateRegistryEntry(workspacePath, toolPath, "disabled", errors.join("; "));
      return { valid: false, errors };
    }

    // All checks passed — mark active and load
    await this.updateRegistryEntry(workspacePath, toolPath, "active");
    this.dynamicTools.set(definition.name, mod as unknown as ToolModule);

    return { valid: true, errors: [] };
  }

  /**
   * Update or insert a tool entry in registry.json.
   */
  private async updateRegistryEntry(
    workspacePath: string,
    toolPath: string,
    status: "active" | "disabled" | "pending",
    error?: string,
  ): Promise<void> {
    const registryPath = `${workspacePath}/tools/registry.json`;
    let registry: { tools: ToolRegistryEntry[] } = { tools: [] };

    try {
      const text = await Bun.file(registryPath).text();
      registry = JSON.parse(text) as { tools: ToolRegistryEntry[] };
    } catch {
      // File doesn't exist yet
    }

    // Derive the tool name from the file
    const relativePath = toolPath.startsWith("/")
      ? toolPath.replace(workspacePath + "/", "")
      : toolPath;
    let toolName = relativePath.replace(/^tools\//, "").replace(/\.ts$/, "");

    // Try to get name from the module if possible
    try {
      const absolutePath = toolPath.startsWith("/")
        ? toolPath
        : `${workspacePath}/${toolPath}`;
      const mod = await import(absolutePath);
      if (mod?.definition?.name) {
        toolName = mod.definition.name;
      }
    } catch {
      // Use filename-derived name
    }

    const existingIndex = registry.tools.findIndex(
      (t) => t.path === relativePath || t.name === toolName,
    );

    const entry: ToolRegistryEntry = {
      name: toolName,
      path: relativePath,
      status,
      validatedAt: Date.now(),
      ...(error ? { error } : {}),
    };

    if (existingIndex >= 0) {
      registry.tools[existingIndex] = entry;
    } else {
      registry.tools.push(entry);
    }

    await Bun.$`mkdir -p ${workspacePath}/tools`.quiet();
    await Bun.write(registryPath, JSON.stringify(registry, null, 2));
  }
}

// ─── Validation Helpers ──────────────────────────────────────────

/**
 * Validate that a module exports the required tool interface.
 */
function validateToolSchema(mod: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (!mod.definition) {
    errors.push("Tool must export a 'definition' object");
    return errors;
  }

  const def = mod.definition as Record<string, unknown>;

  if (typeof def.name !== "string" || def.name.length === 0) {
    errors.push("definition.name must be a non-empty string");
  }

  if (typeof def.description !== "string" || def.description.length === 0) {
    errors.push("definition.description must be a non-empty string");
  }

  if (!def.input_schema || typeof def.input_schema !== "object") {
    errors.push("definition.input_schema must be an object");
  }

  if (typeof mod.handler !== "function") {
    errors.push("Tool must export a 'handler' function");
  }

  return errors;
}

/**
 * Scan a tool's source code for disallowed patterns.
 */
async function scanToolSecurity(
  toolPath: string,
  workspacePath: string,
): Promise<string[]> {
  const errors: string[] = [];

  let source: string;
  try {
    source = await Bun.file(toolPath).text();
  } catch {
    errors.push(`Cannot read tool source at ${toolPath}`);
    return errors;
  }

  // Check disallowed patterns
  for (const { pattern, description } of DISALLOWED_PATTERNS) {
    if (pattern.test(source)) {
      errors.push(`Security violation: disallowed pattern found: ${description}`);
    }
  }

  // Check imports — only relative imports and allowed packages
  const importMatches = source.matchAll(
    /(?:import|from)\s+["']([^"']+)["']/g,
  );
  for (const match of importMatches) {
    const specifier = match[1]!;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      // Relative import — check it doesn't escape workspace
      // Simple check: no traversal past workspace root
      const resolved = resolvePath(toolPath, specifier);
      if (!resolved.startsWith(workspacePath)) {
        errors.push(`Security violation: import escapes workspace: ${specifier}`);
      }
    } else if (!ALLOWED_IMPORT_PACKAGES.has(specifier)) {
      errors.push(`Security violation: disallowed import: ${specifier}`);
    }
  }

  return errors;
}

/**
 * Resolve a relative import path from a source file.
 */
function resolvePath(fromFile: string, relativePath: string): string {
  const dir = fromFile.substring(0, fromFile.lastIndexOf("/"));
  const parts = dir.split("/");
  const relParts = relativePath.replace(/\.ts$/, "").split("/");

  for (const part of relParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  return parts.join("/");
}

/**
 * Check that a test file exists for the tool and that tests pass.
 */
async function checkTestCoverage(toolPath: string): Promise<string[]> {
  const errors: string[] = [];

  // Derive test file path: foo.ts → foo.test.ts
  const testPath = toolPath.replace(/\.ts$/, ".test.ts");

  try {
    const exists = await Bun.file(testPath).exists();
    if (!exists) {
      errors.push(`Test file not found: ${testPath}`);
      return errors;
    }
  } catch {
    errors.push(`Test file not found: ${testPath}`);
    return errors;
  }

  // Run the tests
  const result = await Bun.$`bun test ${testPath}`.nothrow().quiet();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();
    const output = stderr || stdout;
    errors.push(`Tests failed (exit code ${result.exitCode}): ${output.slice(0, 500)}`);
  }

  return errors;
}
