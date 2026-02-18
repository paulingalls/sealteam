import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { definition, createHandler } from "./git.ts";
import { initRepo } from "../git-manager.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-gittool-test-${crypto.randomUUID()}`;
  await initRepo(tmpDir);
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("git tool", () => {
  test("definition has correct name", () => {
    expect(definition.name).toBe("git");
  });

  test("createHandler runs git status", async () => {
    const handler = createHandler(tmpDir);
    const result = await handler({ args: "status" });
    expect(result).toContain("[exit code: 0]");
  });

  test("createHandler runs git add and commit", async () => {
    await Bun.write(`${tmpDir}/test.txt`, "hello");

    const handler = createHandler(tmpDir);
    await handler({ args: "add -A" });
    const result = await handler({ args: "commit -m 'test commit'" });

    expect(result).toContain("test commit");
    expect(result).toContain("[exit code: 0]");
  });

  test("createHandler returns error for bad command", async () => {
    const handler = createHandler(tmpDir);
    const result = await handler({ args: "checkout nonexistent" });
    expect(result).not.toContain("[exit code: 0]");
  });

  test("handles quoted arguments", async () => {
    await Bun.write(`${tmpDir}/test.txt`, "hello");

    const handler = createHandler(tmpDir);
    await handler({ args: "add -A" });
    const result = await handler({
      args: 'commit -m "multi word message"',
    });
    expect(result).toContain("multi word message");
  });
});
