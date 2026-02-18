import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { ToolRegistry } from "./tool-registry.ts";
import type { ToolRegistryEntry } from "./types.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-dynamic-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}/tools`.quiet();
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

// ─── Helper: write a valid tool + test ───────────────────────────

async function writeValidTool(name: string) {
  const toolSource = `
export const definition = {
  name: "${name}",
  description: "A test tool that greets",
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

  const testSource = `
import { test, expect } from "bun:test";
import { definition, handler } from "./${name}.ts";

test("has valid definition", () => {
  expect(definition.name).toBe("${name}");
  expect(definition.description).toBeTruthy();
  expect(definition.input_schema).toBeDefined();
});

test("handler returns string for valid input", async () => {
  const result = await handler({ name: "World" });
  expect(typeof result).toBe("string");
  expect(result).toContain("World");
});

test("handler does not throw on valid input", async () => {
  expect(handler({ name: "Test" })).resolves.toBeDefined();
});
`;

  await Bun.write(`${tmpDir}/tools/${name}.ts`, toolSource);
  await Bun.write(`${tmpDir}/tools/${name}.test.ts`, testSource);
}

// ─── Tests ───────────────────────────────────────────────────────

describe("validateDynamicTool", () => {
  test("valid tool passes all validation steps", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await writeValidTool("greet");

    const result = await registry.validateDynamicTool(
      "tools/greet.ts",
      tmpDir,
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    // Tool should now be loadable
    expect(registry.listTools()).toContain("greet");

    // And executable
    const output = await registry.executeTool("greet", { name: "World" });
    expect(output).toBe("Hello, World!");
  });

  test("rejects tool missing definition export", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // Tool with no definition export
    await Bun.write(`${tmpDir}/tools/bad-def.ts`, `
export async function handler(input: Record<string, unknown>): Promise<string> {
  return "nope";
}
`);
    await Bun.write(`${tmpDir}/tools/bad-def.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool(
      "tools/bad-def.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("definition"))).toBe(true);
  });

  test("rejects tool missing handler export", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/no-handler.ts`, `
export const definition = {
  name: "no-handler",
  description: "A tool without handler",
  input_schema: { type: "object" },
};
`);
    await Bun.write(`${tmpDir}/tools/no-handler.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool(
      "tools/no-handler.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("handler"))).toBe(true);
  });

  test("rejects tool with empty definition name", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/empty-name.ts`, `
export const definition = {
  name: "",
  description: "Has empty name",
  input_schema: { type: "object" },
};
export async function handler() { return "ok"; }
`);
    await Bun.write(`${tmpDir}/tools/empty-name.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool(
      "tools/empty-name.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  test("rejects tool missing test file", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // Write tool but no test file
    await Bun.write(`${tmpDir}/tools/no-tests.ts`, `
export const definition = {
  name: "no-tests",
  description: "A tool without tests",
  input_schema: { type: "object" },
};
export async function handler() { return "ok"; }
`);

    const result = await registry.validateDynamicTool(
      "tools/no-tests.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Test file not found"))).toBe(true);
  });

  test("rejects tool with eval()", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/evil-eval.ts`, `
export const definition = {
  name: "evil-eval",
  description: "Uses eval",
  input_schema: { type: "object", properties: { code: { type: "string" } } },
};
export async function handler(input: Record<string, unknown>): Promise<string> {
  return eval(input.code as string);
}
`);
    await Bun.write(`${tmpDir}/tools/evil-eval.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool(
      "tools/evil-eval.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("eval"))).toBe(true);
  });

  test("rejects tool with new Function()", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/evil-func.ts`, `
export const definition = {
  name: "evil-func",
  description: "Uses new Function",
  input_schema: { type: "object" },
};
export async function handler(input: Record<string, unknown>): Promise<string> {
  const fn = new Function("return 42");
  return String(fn());
}
`);
    await Bun.write(`${tmpDir}/tools/evil-func.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool(
      "tools/evil-func.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Function"))).toBe(true);
  });

  test("rejects tool with process.env access", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/env-snoop.ts`, `
export const definition = {
  name: "env-snoop",
  description: "Reads env vars",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return process.env.SECRET_KEY || "none";
}
`);
    await Bun.write(`${tmpDir}/tools/env-snoop.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool(
      "tools/env-snoop.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("process.env"))).toBe(true);
  });

  test("rejects tool with disallowed import", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/bad-import.ts`, `
import axios from "axios";

export const definition = {
  name: "bad-import",
  description: "Uses disallowed package",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return "ok";
}
`);
    await Bun.write(`${tmpDir}/tools/bad-import.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool(
      "tools/bad-import.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("disallowed import"))).toBe(true);
  });

  test("rejects tool with failing tests", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/fail-test.ts`, `
export const definition = {
  name: "fail-test",
  description: "Has failing tests",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return "ok";
}
`);
    await Bun.write(`${tmpDir}/tools/fail-test.test.ts`, `
import { test, expect } from "bun:test";
test("this test fails", () => {
  expect(1).toBe(2);
});
`);

    const result = await registry.validateDynamicTool(
      "tools/fail-test.ts",
      tmpDir,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Tests failed"))).toBe(true);
  });
});

describe("registry.json persistence", () => {
  test("valid tool is written to registry.json as active", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await writeValidTool("persisted");

    await registry.validateDynamicTool("tools/persisted.ts", tmpDir);

    // Read registry.json
    const registryText = await Bun.file(`${tmpDir}/tools/registry.json`).text();
    const registryData = JSON.parse(registryText) as { tools: ToolRegistryEntry[] };

    expect(registryData.tools).toHaveLength(1);
    expect(registryData.tools[0]!.name).toBe("persisted");
    expect(registryData.tools[0]!.status).toBe("active");
    expect(registryData.tools[0]!.validatedAt).toBeGreaterThan(0);
    expect(registryData.tools[0]!.error).toBeUndefined();
  });

  test("rejected tool is written to registry.json as disabled with error", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/rejected.ts`, `
export const definition = {
  name: "rejected",
  description: "Will be rejected",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return eval("bad");
}
`);
    await Bun.write(`${tmpDir}/tools/rejected.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    await registry.validateDynamicTool("tools/rejected.ts", tmpDir);

    const registryText = await Bun.file(`${tmpDir}/tools/registry.json`).text();
    const registryData = JSON.parse(registryText) as { tools: ToolRegistryEntry[] };

    expect(registryData.tools).toHaveLength(1);
    expect(registryData.tools[0]!.name).toBe("rejected");
    expect(registryData.tools[0]!.status).toBe("disabled");
    expect(registryData.tools[0]!.error).toBeDefined();
    expect(registryData.tools[0]!.error).toContain("eval");
  });

  test("updates existing entry on re-validation", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // First: write a bad tool
    await Bun.write(`${tmpDir}/tools/evolving.ts`, `
export const definition = {
  name: "evolving",
  description: "Starts bad",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return eval("bad");
}
`);
    await Bun.write(`${tmpDir}/tools/evolving.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    await registry.validateDynamicTool("tools/evolving.ts", tmpDir);

    let registryText = await Bun.file(`${tmpDir}/tools/registry.json`).text();
    let registryData = JSON.parse(registryText) as { tools: ToolRegistryEntry[] };
    expect(registryData.tools[0]!.status).toBe("disabled");

    // Fix the tool
    await Bun.write(`${tmpDir}/tools/evolving.ts`, `
export const definition = {
  name: "evolving",
  description: "Now good",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return "ok";
}
`);

    // Re-validate with a fresh registry (to avoid cached import)
    const registry2 = new ToolRegistry();
    registry2.loadBuiltins();
    const result = await registry2.validateDynamicTool("tools/evolving.ts", tmpDir);

    registryText = await Bun.file(`${tmpDir}/tools/registry.json`).text();
    registryData = JSON.parse(registryText) as { tools: ToolRegistryEntry[] };

    // Should still be 1 entry, now active
    expect(registryData.tools).toHaveLength(1);
    expect(registryData.tools[0]!.status).toBe(result.valid ? "active" : "disabled");
  });
});

describe("scanDynamic picks up validated tools", () => {
  test("loads newly active tools after validation", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await writeValidTool("scanner-test");

    // Validate to create registry.json with active status
    const result = await registry.validateDynamicTool("tools/scanner-test.ts", tmpDir);
    expect(result.valid).toBe(true);

    // Create a fresh registry and scan
    const registry2 = new ToolRegistry();
    registry2.loadBuiltins();
    await registry2.scanDynamic(tmpDir);

    expect(registry2.listTools()).toContain("scanner-test");
    const output = await registry2.executeTool("scanner-test", { name: "Alice" });
    expect(output).toBe("Hello, Alice!");
  });

  test("does not load disabled tools", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // Write a tool that will fail validation (has eval)
    await Bun.write(`${tmpDir}/tools/disabled-tool.ts`, `
export const definition = {
  name: "disabled-tool",
  description: "Bad tool",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return eval("bad");
}
`);
    await Bun.write(`${tmpDir}/tools/disabled-tool.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    await registry.validateDynamicTool("tools/disabled-tool.ts", tmpDir);

    // Fresh registry should not pick up the disabled tool
    const registry2 = new ToolRegistry();
    registry2.loadBuiltins();
    await registry2.scanDynamic(tmpDir);

    expect(registry2.listTools()).not.toContain("disabled-tool");
  });
});

describe("security scan edge cases", () => {
  test("allows process.env.ANTHROPIC_API_KEY access", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/api-key-ok.ts`, `
export const definition = {
  name: "api-key-ok",
  description: "Uses API key only",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY || "none";
  return "key length: " + key.length;
}
`);
    await Bun.write(`${tmpDir}/tools/api-key-ok.test.ts`, `
import { test, expect } from "bun:test";
import { definition, handler } from "./api-key-ok.ts";

test("has definition", () => {
  expect(definition.name).toBe("api-key-ok");
});

test("handler returns string", async () => {
  const result = await handler({});
  expect(typeof result).toBe("string");
});

test("does not throw", async () => {
  expect(handler({})).resolves.toBeDefined();
});
`);

    const result = await registry.validateDynamicTool("tools/api-key-ok.ts", tmpDir);

    // Should pass — process.env.ANTHROPIC_API_KEY is allowed
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("allows relative imports within workspace", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    // Create a helper module within the workspace
    await Bun.write(`${tmpDir}/tools/helper.ts`, `
export function greetHelper(name: string): string {
  return "Hi, " + name;
}
`);

    await Bun.write(`${tmpDir}/tools/uses-helper.ts`, `
import { greetHelper } from "./helper.ts";

export const definition = {
  name: "uses-helper",
  description: "Uses a helper module",
  input_schema: { type: "object", properties: { name: { type: "string" } } },
};

export async function handler(input: Record<string, unknown>): Promise<string> {
  return greetHelper(input.name as string);
}
`);
    await Bun.write(`${tmpDir}/tools/uses-helper.test.ts`, `
import { test, expect } from "bun:test";
import { definition, handler } from "./uses-helper.ts";

test("has definition", () => {
  expect(definition.name).toBe("uses-helper");
});

test("handler returns greeting", async () => {
  const result = await handler({ name: "Bob" });
  expect(result).toBe("Hi, Bob");
});

test("handler works with different input", async () => {
  const result = await handler({ name: "Alice" });
  expect(result).toContain("Alice");
});
`);

    const result = await registry.validateDynamicTool("tools/uses-helper.ts", tmpDir);
    expect(result.valid).toBe(true);
  });

  test("rejects tool that imports file outside workspace", async () => {
    const registry = new ToolRegistry();
    registry.loadBuiltins();

    await Bun.write(`${tmpDir}/tools/escaper.ts`, `
import { something } from "../../etc/passwd";

export const definition = {
  name: "escaper",
  description: "Escapes workspace",
  input_schema: { type: "object" },
};
export async function handler(): Promise<string> {
  return "ok";
}
`);
    await Bun.write(`${tmpDir}/tools/escaper.test.ts`, `
import { test, expect } from "bun:test";
test("placeholder", () => { expect(true).toBe(true); });
`);

    const result = await registry.validateDynamicTool("tools/escaper.ts", tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("escapes workspace"))).toBe(true);
  });
});
