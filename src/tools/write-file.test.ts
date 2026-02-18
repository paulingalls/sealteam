import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { handler, definition } from "./write-file.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-writefile-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}`.quiet();
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("write-file tool", () => {
  test("definition has correct name", () => {
    expect(definition.name).toBe("write-file");
  });

  test("writes content to file", async () => {
    const path = `${tmpDir}/out.txt`;
    const result = await handler({ path, content: "hello world" });

    expect(result).toContain("Successfully wrote");
    expect(result).toContain("11 characters");
    expect(await Bun.file(path).text()).toBe("hello world");
  });

  test("creates parent directories", async () => {
    const path = `${tmpDir}/deep/nested/dir/out.txt`;
    const result = await handler({ path, content: "deep content" });

    expect(result).toContain("Successfully wrote");
    expect(await Bun.file(path).text()).toBe("deep content");
  });

  test("overwrites existing file", async () => {
    const path = `${tmpDir}/overwrite.txt`;
    await Bun.write(path, "old content");

    await handler({ path, content: "new content" });
    expect(await Bun.file(path).text()).toBe("new content");
  });
});
