import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ToolRegistry } from "./tool-registry.ts";
import { MessageQueue } from "./message-queue.ts";
import { MockRedis } from "./mock-redis.ts";

let tmpDir: string;
let mq: MessageQueue;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-registry-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}/tools`.quiet();
  mq = new MessageQueue(new MockRedis());
});

afterEach(async () => {
  mq.close();
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("ToolRegistry", () => {
  test("loadBuiltins registers all 8 tools", () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    const tools = registry.listTools();
    expect(tools).toContain("bash");
    expect(tools).toContain("read-file");
    expect(tools).toContain("write-file");
    expect(tools).toContain("web-search");
    expect(tools).toContain("web-fetch");
    expect(tools).toContain("git");
    expect(tools).toContain("send-message");
    expect(tools).toContain("spawn-agent");
    expect(tools).toContain("create-tool");
    expect(tools).toHaveLength(10);
  });

  test("getToolDefinitions filters by tool names", () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    const defs = registry.getToolDefinitions(["bash", "read-file"]);
    expect(defs).toHaveLength(2);

    const names = defs.map((d) => d.name);
    expect(names).toContain("bash");
    expect(names).toContain("read-file");
  });

  test("getToolDefinitions excludes server-side tools", () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    const defs = registry.getToolDefinitions([
      "bash",
      "web-search",
      "web-fetch",
    ]);
    // Only bash should appear — web-search and web-fetch are server-side
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("bash");
  });

  test("getServerTools returns server tool specs", () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    const serverTools = registry.getServerTools([
      "bash",
      "web-search",
      "web-fetch",
    ]);
    expect(serverTools).toHaveLength(2);

    const types = serverTools.map((t) => (t as unknown as Record<string, string>).type);
    expect(types).toContain("web_search_20250305");
    expect(types).toContain("web_fetch_20250910");
  });

  test("getServerTools returns empty for non-server tools", () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    const serverTools = registry.getServerTools(["bash", "git"]);
    expect(serverTools).toHaveLength(0);
  });

  test("getAllToolsForApi combines local and server tools", () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    const all = registry.getAllToolsForApi([
      "bash",
      "read-file",
      "web-search",
    ]);
    expect(all).toHaveLength(3); // bash + read-file (local) + web-search (server)
  });

  test("executeTool runs bash handler", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    const result = await registry.executeTool("bash", {
      command: "echo hello",
    });
    expect(result).toContain("hello");
  });

  test("executeTool throws for server-side tools", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    expect(
      registry.executeTool("web-search", {}),
    ).rejects.toThrow("server-side tool");
  });

  test("executeTool throws for unknown tools", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    expect(
      registry.executeTool("nonexistent", {}),
    ).rejects.toThrow("Tool not found");
  });

  test("isServerTool correctly identifies server tools", () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    expect(registry.isServerTool("web-search")).toBe(true);
    expect(registry.isServerTool("web-fetch")).toBe(true);
    expect(registry.isServerTool("bash")).toBe(false);
    expect(registry.isServerTool("git")).toBe(false);
  });

  test("bindAgentContext binds git to working directory", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // Create a temp git repo
    const repoDir = `${tmpDir}/repo`;
    await Bun.$`git init ${repoDir}`.quiet();
    await Bun.$`git -C ${repoDir} config user.email test@test.com`.quiet();
    await Bun.$`git -C ${repoDir} config user.name Test`.quiet();

    registry.bindAgentContext({
      agentName: "alice",
      workDir: repoDir,
      messageQueue: mq,
      workspacePath: tmpDir,
    });

    // The bound git tool should work in the repo dir
    const result = await registry.executeTool("git", { args: "status" });
    expect(result).toContain("[exit code: 0]");
  });

  test("scanDynamic loads active tools from registry.json", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // Create a dynamic tool
    const toolSource = `
      export const definition = {
        name: "greet",
        description: "Greet someone",
        input_schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      };
      export async function handler(input) {
        return "Hello, " + input.name + "!";
      }
    `;
    await Bun.write(`${tmpDir}/tools/greet.ts`, toolSource);

    // Write registry.json marking it active
    const registryJson = {
      tools: [
        {
          name: "greet",
          path: "tools/greet.ts",
          status: "active",
          validatedAt: Date.now(),
        },
      ],
    };
    await Bun.write(
      `${tmpDir}/tools/registry.json`,
      JSON.stringify(registryJson),
    );

    await registry.scanDynamic(tmpDir);

    const tools = registry.listTools();
    expect(tools).toContain("greet");

    const result = await registry.executeTool("greet", { name: "World" });
    expect(result).toBe("Hello, World!");
  });

  test("scanDynamic skips disabled tools", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/bad.ts`, `
      export const definition = { name: "bad", description: "bad", input_schema: { type: "object" } };
      export async function handler() { return "bad"; }
    `);

    const registryJson = {
      tools: [
        { name: "bad", path: "tools/bad.ts", status: "disabled" },
      ],
    };
    await Bun.write(
      `${tmpDir}/tools/registry.json`,
      JSON.stringify(registryJson),
    );

    await registry.scanDynamic(tmpDir);

    const tools = registry.listTools();
    expect(tools).not.toContain("bad");
  });

  test("scanDynamic handles missing registry.json gracefully", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // No registry.json exists — should not throw
    await registry.scanDynamic(tmpDir);
    expect(registry.listTools()).toHaveLength(10); // just builtins
  });
});
