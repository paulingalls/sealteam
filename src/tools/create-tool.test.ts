import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ToolRegistry } from "../tool-registry.ts";
import { createHandler, definition } from "./create-tool.ts";
import type { CreateToolContext } from "./create-tool.ts";
import type { ToolRegistryEntry } from "../types.ts";

let tmpDir: string;
let registry: ToolRegistry;
let ctx: CreateToolContext;
let handler: (input: Record<string, unknown>) => Promise<string>;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-create-tool-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}/tools`.quiet();

  registry = new ToolRegistry();
  registry.loadBuiltins();

  ctx = { workspacePath: tmpDir, toolRegistry: registry };
  handler = createHandler(ctx);
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

// ─── Valid tool source helpers ────────────────────────────────────

const validSource = `
export const definition = {
  name: "greet",
  description: "Greets a person by name",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name to greet" },
    },
    required: ["name"],
  },
};

export async function handler(input: Record<string, unknown>): Promise<string> {
  return "Hello, " + (input.name as string) + "!";
}
`;

const validTestSource = `
import { test, expect } from "bun:test";
import { definition, handler } from "./greet.ts";

test("has valid definition", () => {
  expect(definition.name).toBe("greet");
  expect(definition.description).toBeTruthy();
  expect(definition.input_schema).toBeDefined();
});

test("handler returns greeting", async () => {
  const result = await handler({ name: "World" });
  expect(result).toBe("Hello, World!");
});

test("handler works with different names", async () => {
  const result = await handler({ name: "Alice" });
  expect(result).toContain("Alice");
});
`;

// ─── Tests ────────────────────────────────────────────────────────

describe("create-tool definition", () => {
  test("has correct name and required fields", () => {
    expect(definition.name).toBe("create-tool");
    expect(definition.description).toBeTruthy();
    expect(definition.input_schema).toBeDefined();
    const schema = definition.input_schema as { required: string[] };
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("source");
    expect(schema.required).toContain("test_source");
  });
});

describe("create-tool handler", () => {
  test("creates and validates a valid tool", async () => {
    const result = await handler({
      name: "greet",
      source: validSource,
      test_source: validTestSource,
    });

    expect(result).toContain("created and activated successfully");
    expect(result).toContain("greet");

    // Tool should be registered and usable
    expect(registry.listTools()).toContain("greet");
    const output = await registry.executeTool("greet", { name: "World" });
    expect(output).toBe("Hello, World!");
  });

  test("writes tool files to workspace/tools/", async () => {
    await handler({
      name: "greet",
      source: validSource,
      test_source: validTestSource,
    });

    const toolExists = await Bun.file(`${tmpDir}/tools/greet.ts`).exists();
    const testExists = await Bun.file(`${tmpDir}/tools/greet.test.ts`).exists();
    expect(toolExists).toBe(true);
    expect(testExists).toBe(true);
  });

  test("persists tool in registry.json as active", async () => {
    await handler({
      name: "greet",
      source: validSource,
      test_source: validTestSource,
    });

    const registryText = await Bun.file(`${tmpDir}/tools/registry.json`).text();
    const registryData = JSON.parse(registryText) as { tools: ToolRegistryEntry[] };

    expect(registryData.tools.length).toBeGreaterThanOrEqual(1);
    const entry = registryData.tools.find((t) => t.name === "greet");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("active");
  });

  test("tool is available via scanDynamic after creation", async () => {
    await handler({
      name: "greet",
      source: validSource,
      test_source: validTestSource,
    });

    // Create a fresh registry and scan — simulates a new session
    const freshRegistry = new ToolRegistry();
    freshRegistry.loadBuiltins();
    await freshRegistry.scanDynamic(tmpDir);

    expect(freshRegistry.listTools()).toContain("greet");
    const output = await freshRegistry.executeTool("greet", { name: "Bob" });
    expect(output).toBe("Hello, Bob!");
  });

  test("rejects invalid tool name", async () => {
    const result = await handler({
      name: "Invalid Name!",
      source: validSource,
      test_source: validTestSource,
    });

    expect(result).toContain("Error");
    expect(result).toContain("kebab-case");
  });

  test("rejects empty source", async () => {
    const result = await handler({
      name: "empty",
      source: "",
      test_source: validTestSource,
    });

    expect(result).toContain("Error");
    expect(result).toContain("source code is required");
  });

  test("rejects empty test source", async () => {
    const result = await handler({
      name: "no-test",
      source: validSource,
      test_source: "",
    });

    expect(result).toContain("Error");
    expect(result).toContain("Test source code is required");
  });

  test("rejects tool with security violation (eval)", async () => {
    const evilSource = `
export const definition = {
  name: "evil",
  description: "Uses eval",
  input_schema: { type: "object", properties: { code: { type: "string" } } },
};

export async function handler(input: Record<string, unknown>): Promise<string> {
  return eval(input.code as string);
}
`;
    const evilTestSource = `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`;

    const result = await handler({
      name: "evil",
      source: evilSource,
      test_source: evilTestSource,
    });

    expect(result).toContain("failed validation");
    expect(result).toContain("eval");

    // Tool files should be cleaned up
    const toolExists = await Bun.file(`${tmpDir}/tools/evil.ts`).exists();
    expect(toolExists).toBe(false);
  });

  test("rejects tool with failing tests", async () => {
    const failingTestSource = `
import { test, expect } from "bun:test";
import { handler } from "./greet.ts";

test("this test fails", async () => {
  const result = await handler({ name: "World" });
  expect(result).toBe("WRONG ANSWER");
});
`;

    const result = await handler({
      name: "greet",
      source: validSource,
      test_source: failingTestSource,
    });

    expect(result).toContain("failed validation");
    expect(result).toContain("Tests failed");
  });

  test("getDynamicToolNames returns created tool", async () => {
    expect(registry.getDynamicToolNames()).not.toContain("greet");

    await handler({
      name: "greet",
      source: validSource,
      test_source: validTestSource,
    });

    expect(registry.getDynamicToolNames()).toContain("greet");
  });
});
