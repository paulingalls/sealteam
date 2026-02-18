import { test, expect, describe } from "bun:test";
import { handler, definition } from "./bash.ts";

describe("bash tool", () => {
  test("definition has correct name", () => {
    expect(definition.name).toBe("bash");
  });

  test("executes simple command", async () => {
    const result = await handler({ command: "echo hello" });
    expect(result).toContain("hello");
    expect(result).toContain("[exit code: 0]");
  });

  test("captures stderr", async () => {
    const result = await handler({ command: "echo error >&2" });
    expect(result).toContain("[stderr]");
    expect(result).toContain("error");
  });

  test("returns non-zero exit code", async () => {
    const result = await handler({ command: "exit 42" });
    expect(result).toContain("[exit code: 42]");
  });

  test("respects cwd option", async () => {
    const result = await handler({ command: "pwd", cwd: "/tmp" });
    expect(result).toContain("/tmp");
    // On macOS /tmp is a symlink to /private/tmp
  });

  test("handles multi-line output", async () => {
    const result = await handler({
      command: "echo line1 && echo line2 && echo line3",
    });
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line3");
  });
});
