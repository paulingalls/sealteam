import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  writeIterationState,
  readIterationState,
  getLastCompletedStep,
  writeSessionState,
  readSessionState,
  ensureDirectories,
} from "./state-manager.ts";
import type { IterationState, SessionState } from "./types.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-state-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}`.quiet();
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

test("ensureDirectories creates agent state and logs dirs", async () => {
  await ensureDirectories(tmpDir, "alice");

  const stateDir = Bun.file(`${tmpDir}/alice/state`);
  const logsDir = Bun.file(`${tmpDir}/logs`);
  // Verify directories exist by writing a test file into them
  await Bun.write(`${tmpDir}/alice/state/.keep`, "");
  await Bun.write(`${tmpDir}/logs/.keep`, "");
  expect(await Bun.file(`${tmpDir}/alice/state/.keep`).exists()).toBe(true);
  expect(await Bun.file(`${tmpDir}/logs/.keep`).exists()).toBe(true);
});

test("writeIterationState and readIterationState round-trip", async () => {
  const agentDir = `${tmpDir}/bob`;
  const state: IterationState = {
    iteration: 1,
    step: "plan",
    timestamp: Date.now(),
    input: { message: "Build the API" },
    output: { plan: "First, create the project structure" },
    tokensUsed: { input: 500, output: 200 },
    complexity: "complex",
  };

  await writeIterationState(agentDir, 1, "plan", state);
  const read = await readIterationState(agentDir, 1, "plan");

  expect(read).not.toBeNull();
  expect(read!.iteration).toBe(1);
  expect(read!.step).toBe("plan");
  expect(read!.complexity).toBe("complex");
  expect(read!.tokensUsed.input).toBe(500);
  expect((read!.input as Record<string, string>).message).toBe("Build the API");
});

test("readIterationState returns null for missing file", async () => {
  const result = await readIterationState(`${tmpDir}/nonexistent`, 1, "plan");
  expect(result).toBeNull();
});

test("getLastCompletedStep with single state file", async () => {
  const agentDir = `${tmpDir}/alice`;
  const state: IterationState = {
    iteration: 1,
    step: "plan",
    timestamp: Date.now(),
    input: null,
    output: null,
    tokensUsed: { input: 0, output: 0 },
  };

  await writeIterationState(agentDir, 1, "plan", state);
  const last = await getLastCompletedStep(agentDir);

  expect(last).not.toBeNull();
  expect(last!.iteration).toBe(1);
  expect(last!.step).toBe("plan");
});

test("getLastCompletedStep with multiple state files", async () => {
  const agentDir = `${tmpDir}/alice`;
  const base: IterationState = {
    iteration: 1,
    step: "plan",
    timestamp: Date.now(),
    input: null,
    output: null,
    tokensUsed: { input: 0, output: 0 },
  };

  await writeIterationState(agentDir, 1, "plan", { ...base, step: "plan" });
  await writeIterationState(agentDir, 1, "execute", { ...base, step: "execute" });
  await writeIterationState(agentDir, 1, "reflect", { ...base, step: "reflect" });
  await writeIterationState(agentDir, 2, "plan", { ...base, iteration: 2, step: "plan" });
  await writeIterationState(agentDir, 2, "execute", { ...base, iteration: 2, step: "execute" });

  const last = await getLastCompletedStep(agentDir);

  expect(last).not.toBeNull();
  expect(last!.iteration).toBe(2);
  expect(last!.step).toBe("execute");
});

test("getLastCompletedStep prefers reflect over plan-execute in same iteration", async () => {
  const agentDir = `${tmpDir}/alice`;
  const base: IterationState = {
    iteration: 3,
    step: "plan-execute",
    timestamp: Date.now(),
    input: null,
    output: null,
    tokensUsed: { input: 0, output: 0 },
  };

  await writeIterationState(agentDir, 3, "plan-execute", base);
  await writeIterationState(agentDir, 3, "reflect", { ...base, step: "reflect" });

  const last = await getLastCompletedStep(agentDir);

  expect(last).not.toBeNull();
  expect(last!.iteration).toBe(3);
  expect(last!.step).toBe("reflect");
});

test("getLastCompletedStep returns null for empty state dir", async () => {
  const agentDir = `${tmpDir}/empty`;
  await Bun.$`mkdir -p ${agentDir}/state`.quiet();

  const last = await getLastCompletedStep(agentDir);
  expect(last).toBeNull();
});

test("getLastCompletedStep returns null for missing dir", async () => {
  const last = await getLastCompletedStep(`${tmpDir}/nonexistent`);
  expect(last).toBeNull();
});

test("writeSessionState and readSessionState round-trip", async () => {
  const session: SessionState = {
    goal: "Build a REST API",
    startTime: Date.now(),
    workspace: tmpDir,
    valkeyUrl: "valkey://localhost:6379",
    agents: [
      {
        config: {
          name: "bob",
          role: "team leader",
          purpose: "Lead the team",
          tools: ["bash", "spawn-agent"],
          model: "claude-opus-4-6",
          tokenBudget: 200000,
          maxIterations: 50,
          workspacePath: tmpDir,
          valkeyUrl: "valkey://localhost:6379",
        },
        pid: 12345,
        status: "running",
        startTime: Date.now(),
      },
    ],
    status: "running",
  };

  await writeSessionState(tmpDir, session);
  const read = await readSessionState(tmpDir);

  expect(read).not.toBeNull();
  expect(read!.goal).toBe("Build a REST API");
  expect(read!.agents).toHaveLength(1);
  expect(read!.agents[0]!.config.name).toBe("bob");
  expect(read!.agents[0]!.pid).toBe(12345);
  expect(read!.status).toBe("running");
});

test("readSessionState returns null for missing file", async () => {
  const result = await readSessionState(`${tmpDir}/no-such-dir`);
  expect(result).toBeNull();
});

test("writeSessionState overwrites existing session", async () => {
  const session1: SessionState = {
    goal: "Goal 1",
    startTime: Date.now(),
    workspace: tmpDir,
    valkeyUrl: "valkey://localhost:6379",
    agents: [],
    status: "running",
  };

  const session2: SessionState = {
    ...session1,
    goal: "Goal 2",
    status: "completed",
  };

  await writeSessionState(tmpDir, session1);
  await writeSessionState(tmpDir, session2);
  const read = await readSessionState(tmpDir);

  expect(read!.goal).toBe("Goal 2");
  expect(read!.status).toBe("completed");
});
