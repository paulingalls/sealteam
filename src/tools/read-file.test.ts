import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { handler, definition } from "./read-file.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-readfile-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}`.quiet();
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("read-file tool", () => {
  test("definition has correct name", () => {
    expect(definition.name).toBe("read-file");
  });

  test("reads file contents", async () => {
    const path = `${tmpDir}/test.txt`;
    await Bun.write(path, "hello world");

    const result = await handler({ path });
    expect(result).toBe("hello world");
  });

  test("returns error for missing file", async () => {
    const result = await handler({ path: `${tmpDir}/nonexistent.txt` });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  test("reads multi-line file", async () => {
    const content = "line 1\nline 2\nline 3\n";
    const path = `${tmpDir}/multi.txt`;
    await Bun.write(path, content);

    const result = await handler({ path });
    expect(result).toBe(content);
  });
});
