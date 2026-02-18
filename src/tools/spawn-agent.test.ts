import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { definition, createHandler } from "./spawn-agent.ts";
import type { SpawnContext } from "./spawn-agent.ts";
import { initRepo, createGitignore, commitAll } from "../git-manager.ts";
import { readSessionState, writeSessionState } from "../state-manager.ts";
import type { SessionState } from "../types.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-spawn-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}`.quiet();

  // Setup leader repo
  const leaderDir = `${tmpDir}/bob`;
  await initRepo(leaderDir);
  await createGitignore(leaderDir);
  await commitAll(leaderDir, "Initial commit");

  // Write initial session state
  const session: SessionState = {
    goal: "test",
    startTime: Date.now(),
    workspace: tmpDir,
    valkeyUrl: "valkey://localhost:6379",
    agents: [],
    status: "running",
  };
  await writeSessionState(tmpDir, session);
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("spawn-agent tool", () => {
  test("definition has correct name", () => {
    expect(definition.name).toBe("spawn-agent");
  });

  test("spawns agent subprocess and updates session", async () => {
    const ctx: SpawnContext = {
      workspacePath: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      defaultModel: "claude-sonnet-4-6",
      defaultBudget: 100000,
      defaultMaxIterations: 50,
      maxWorkers: 6,
    };

    const handler = createHandler(ctx);

    // Use a trivial script that exits immediately instead of life-loop
    // The spawn will succeed but the process will exit quickly since
    // src/life-loop.ts doesn't exist yet
    const result = await handler({
      name: "alice",
      role: "backend engineer",
      purpose: "Build the REST API",
      tools: ["bash", "read-file", "write-file", "git"],
    });

    expect(result).toContain('Agent "alice" spawned');
    expect(result).toContain("PID:");
    expect(result).toContain("backend engineer");

    // Verify session state was updated
    const session = await readSessionState(tmpDir);
    expect(session).not.toBeNull();
    const agentEntry = session!.agents.find(
      (a) => a.config.name === "alice",
    );
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.config.role).toBe("backend engineer");
    expect(agentEntry!.status).toBe("running");

    // Verify agent directory was created with git clone
    expect(await Bun.file(`${tmpDir}/alice/.git/HEAD`).exists()).toBe(true);
  });

  test("enforces worker limit", async () => {
    // Write session with agents at limit
    const session: SessionState = {
      goal: "test",
      startTime: Date.now(),
      workspace: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      agents: Array.from({ length: 2 }, (_, i) => ({
        config: {
          name: `worker-${i}`,
          role: "worker",
          purpose: "work",
          tools: [],
          model: "claude-sonnet-4-6",
          tokenBudget: 100000,
          maxIterations: 50,
          workspacePath: tmpDir,
          valkeyUrl: "valkey://localhost:6379",
        },
        pid: 1000 + i,
        status: "running" as const,
        startTime: Date.now(),
      })),
      status: "running",
    };
    await writeSessionState(tmpDir, session);

    const ctx: SpawnContext = {
      workspacePath: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      defaultModel: "claude-sonnet-4-6",
      defaultBudget: 100000,
      defaultMaxIterations: 50,
      maxWorkers: 2, // limit to 2
    };

    const handler = createHandler(ctx);
    const result = await handler({
      name: "overflow",
      role: "extra worker",
      purpose: "too many",
      tools: ["bash"],
    });

    expect(result).toContain("Maximum worker limit reached");
  });

  test("uses default model and budget when not specified", async () => {
    const ctx: SpawnContext = {
      workspacePath: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      defaultModel: "claude-sonnet-4-6",
      defaultBudget: 50000,
      defaultMaxIterations: 25,
      maxWorkers: 6,
    };

    const handler = createHandler(ctx);
    await handler({
      name: "charlie",
      role: "writer",
      purpose: "Write docs",
      tools: ["bash", "write-file"],
    });

    const session = await readSessionState(tmpDir);
    const agent = session!.agents.find((a) => a.config.name === "charlie");
    expect(agent!.config.model).toBe("claude-sonnet-4-6");
    expect(agent!.config.tokenBudget).toBe(50000);
    expect(agent!.config.maxIterations).toBe(25);
  });
});
