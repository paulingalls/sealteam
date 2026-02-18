import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runLifeLoop } from "./life-loop.ts";
import type { LifeLoopDeps } from "./life-loop.ts";
import type { AgentConfig, QueueMessage, TokenUsage } from "./types.ts";
import type { CallParams, CallResult, Message, MessageParam } from "./claude-client.ts";
import type { ClaudeClient } from "./claude-client.ts";
import { MessageQueue } from "./message-queue.ts";
import { MockRedis } from "./mock-redis.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { ContextManager } from "./context-manager.ts";
import { readIterationState } from "./state-manager.ts";

// ─── Mock Claude Client ──────────────────────────────────────────

type ResponseFn = (params: CallParams) => CallResult;

interface MockClaudeClient extends ClaudeClient {
  callLog: CallParams[];
  addResponse(fn: ResponseFn): void;
}

function createMockClient(): MockClaudeClient {
  const responses: ResponseFn[] = [];
  let callIndex = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const callLog: CallParams[] = [];

  return {
    callLog,
    addResponse(fn: ResponseFn) {
      responses.push(fn);
    },
    async call(params: CallParams): Promise<CallResult> {
      callLog.push(params);
      const fn = responses[callIndex];
      if (!fn) {
        throw new Error(
          `MockClaudeClient: no response configured for call ${callIndex}. ` +
          `System prompt starts with: "${params.systemPrompt.slice(0, 80)}..."`,
        );
      }
      callIndex++;
      const result = fn(params);
      totalInput += result.tokensUsed.input;
      totalOutput += result.tokensUsed.output;
      return result;
    },
    getTokenUsage() {
      return { input: totalInput, output: totalOutput, total: totalInput + totalOutput };
    },
    estimateTokens(text: string) {
      return Math.ceil(text.length / 4);
    },
  } as MockClaudeClient;
}

// ─── Response Helpers ────────────────────────────────────────────

function textResponse(text: string, tokens = { input: 100, output: 50 }): CallResult {
  return {
    response: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text, citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: tokens.input, output_tokens: tokens.output, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, inference_geo: null, cache_creation: null },
    } as Message,
    tokensUsed: tokens,
  };
}

function toolUseResponse(
  toolName: string,
  input: Record<string, unknown>,
  tokens = { input: 100, output: 50 },
): CallResult {
  return {
    response: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        { type: "tool_use", id: `tu_${crypto.randomUUID().slice(0, 8)}`, name: toolName, input },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: tokens.input, output_tokens: tokens.output, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, inference_geo: null, cache_creation: null },
    } as Message,
    tokensUsed: tokens,
  };
}

function planResponse(plan: string, complexity: "simple" | "complex" = "complex"): CallResult {
  return textResponse(JSON.stringify({
    plan,
    reasoning: "test reasoning",
    complexity,
    steps: ["step 1"],
  }));
}

function reflectResponse(
  decision: "continue" | "complete" | "error",
  opts: { nextMessage?: string; errorDetails?: string; iteration?: number } = {},
): CallResult {
  return textResponse(JSON.stringify({
    decision,
    summary: {
      iteration: opts.iteration ?? 1,
      plan: "test plan",
      outcome: "test outcome",
      filesChanged: [],
      decisions: [],
    },
    nextMessage: opts.nextMessage,
    errorDetails: opts.errorDetails,
  }));
}

// ─── Test Setup ──────────────────────────────────────────────────

let tmpDir: string;
let mq: MessageQueue;
let agentId: string;

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: agentId,
    role: "test role",
    purpose: "test purpose",
    tools: ["bash", "read-file", "write-file"],
    model: "claude-sonnet-4-6",
    tokenBudget: 100000,
    maxIterations: 5,
    workspacePath: tmpDir,
    valkeyUrl: "valkey://localhost:6379",
    ...overrides,
  };
}

function makeDeps(mockClient: MockClaudeClient): LifeLoopDeps {
  const toolRegistry = new ToolRegistry();
  toolRegistry.loadBuiltins();
  toolRegistry.bindAgentContext({
    agentName: agentId,
    workDir: `${tmpDir}/${agentId}`,
    messageQueue: mq,
    workspacePath: tmpDir,
  });
  const contextManager = new ContextManager("claude-sonnet-4-6");

  return {
    claudeClient: mockClient as unknown as ClaudeClient,
    messageQueue: mq,
    toolRegistry,
    contextManager,
  };
}

beforeEach(async () => {
  agentId = `ta-${crypto.randomUUID().slice(0, 8)}`;
  tmpDir = `/tmp/sealteam-loop-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}/${agentId}/state`.quiet();
  await Bun.$`mkdir -p ${tmpDir}/logs`.quiet();
  mq = new MessageQueue(new MockRedis());
});

afterEach(async () => {
  mq.close();
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

// ─── Tests ───────────────────────────────────────────────────────

describe("standard path (plan → execute → reflect)", () => {
  test("makes 3 API calls per iteration and completes", async () => {
    const config = makeConfig({ maxIterations: 1 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    // Send initial task message
    await mq.send({
      id: "msg-1",
      from: "bob",
      to: agentId,
      type: "task",
      content: "Do something simple",
      timestamp: Date.now(),
    });

    // 1. Plan response
    mock.addResponse(() => planResponse("Do the task", "complex"));
    // 2. Execute response (no tool calls, just text)
    mock.addResponse(() => textResponse("Task executed successfully"));
    // 3. Reflect → complete
    mock.addResponse(() => reflectResponse("complete"));

    await runLifeLoop(config, deps);

    expect(mock.callLog).toHaveLength(3);

    // Verify state files were written
    const planState = await readIterationState(`${tmpDir}/${agentId}`, 1, "plan");
    expect(planState).not.toBeNull();
    expect(planState!.step).toBe("plan");

    const execState = await readIterationState(`${tmpDir}/${agentId}`, 1, "execute");
    expect(execState).not.toBeNull();

    const reflectState = await readIterationState(`${tmpDir}/${agentId}`, 1, "reflect");
    expect(reflectState).not.toBeNull();
  });

  test("sends complete message to leader on completion", async () => {
    const config = makeConfig({ maxIterations: 1 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    // Drain any stale messages from bob's queue
    while (await mq.receiveNonBlocking("bob")) {}

    await mq.send({
      id: "msg-1", from: "bob", to: agentId,
      type: "task", content: "Do it", timestamp: Date.now(),
    });

    mock.addResponse(() => planResponse("plan", "complex"));
    mock.addResponse(() => textResponse("done"));
    mock.addResponse(() => reflectResponse("complete"));

    await runLifeLoop(config, deps);

    // Check that a complete message was sent to bob
    const bobMsg = await mq.receiveNonBlocking("bob");
    expect(bobMsg).not.toBeNull();
    expect(bobMsg!.type).toBe("complete");
    expect(bobMsg!.from).toBe(agentId);
  });
});

describe("fast path (plan+execute → reflect)", () => {
  test("uses 2 API calls when previous complexity was simple", async () => {
    const config = makeConfig({ maxIterations: 3 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    // Iteration 1: standard path, returns simple complexity
    await mq.send({
      id: "msg-1", from: "bob", to: agentId,
      type: "task", content: "First task", timestamp: Date.now(),
    });

    // Iter 1: plan (simple) → execute → reflect (continue)
    mock.addResponse(() => planResponse("First plan", "simple"));
    mock.addResponse(() => textResponse("First executed"));
    mock.addResponse(() => reflectResponse("continue", { nextMessage: "Next task" }));

    // Iter 2: fast path (plan+execute) → reflect (complete)
    mock.addResponse(() => textResponse("Fast path done"));
    mock.addResponse(() => reflectResponse("complete", { iteration: 2 }));

    await runLifeLoop(config, deps);

    // Iter 1: 3 calls, Iter 2: 2 calls = 5 total
    expect(mock.callLog).toHaveLength(5);

    // Verify fast path state file
    const peState = await readIterationState(`${tmpDir}/${agentId}`, 2, "plan-execute");
    expect(peState).not.toBeNull();
  });
});

describe("tool call loop", () => {
  test("processes tool_use blocks and sends results back", async () => {
    const config = makeConfig({ maxIterations: 1 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    await mq.send({
      id: "msg-1", from: "bob", to: agentId,
      type: "task", content: "Run a command", timestamp: Date.now(),
    });

    // Plan
    mock.addResponse(() => planResponse("Run echo", "complex"));
    // Execute: first call returns tool_use
    mock.addResponse(() => toolUseResponse("bash", { command: "echo hello" }));
    // Execute: second call after tool result, returns text
    mock.addResponse(() => textResponse("Command output: hello"));
    // Reflect
    mock.addResponse(() => reflectResponse("complete"));

    await runLifeLoop(config, deps);

    // 4 calls: plan, execute (tool_use), execute (after tool result), reflect
    expect(mock.callLog).toHaveLength(4);
  });
});

describe("error handling and self-recovery", () => {
  test("retries up to 3 times then escalates to leader", async () => {
    const config = makeConfig({ maxIterations: 3 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    await mq.send({
      id: "msg-1", from: "bob", to: agentId,
      type: "task", content: "Do something", timestamp: Date.now(),
    });

    // 3 iterations with errors:
    // After iter 1 error (attempt 1): self-queues retry
    // After iter 2 error (attempt 2): self-queues retry
    // After iter 3 error (attempt 3): escalates to leader, then maxIterations hit
    for (let i = 0; i < 3; i++) {
      mock.addResponse(() => planResponse("try again", "complex"));
      mock.addResponse(() => textResponse("failed"));
      mock.addResponse(() => reflectResponse("error", {
        errorDetails: "Something broke",
        iteration: i + 1,
      }));
    }

    await runLifeLoop(config, deps);

    // Check for escalation message to bob
    const bobMessages: QueueMessage[] = [];
    let msg = await mq.receiveNonBlocking("bob");
    while (msg) {
      bobMessages.push(msg);
      msg = await mq.receiveNonBlocking("bob");
    }

    const errorMsgs = bobMessages.filter((m) => m.type === "error");
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(errorMsgs[0]!.content).toContain("recovery attempts");
  });
});

describe("cancellation", () => {
  test("exits on cancel message", async () => {
    const config = makeConfig({ maxIterations: 10 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    // Init a git repo for the agent so cancellation commit works
    await Bun.$`git init ${tmpDir}/${agentId}`.quiet();
    await Bun.$`git -C ${tmpDir}/${agentId} config user.email test@test.com`.quiet();
    await Bun.$`git -C ${tmpDir}/${agentId} config user.name Test`.quiet();

    // Drain any leftover messages from bob's queue (from prior tests)
    while (await mq.receiveNonBlocking("bob")) {}

    // Send cancel message
    await mq.send({
      id: "cancel-1", from: "bob", to: agentId,
      type: "cancel", content: "No longer needed", timestamp: Date.now(),
    });

    await runLifeLoop(config, deps);

    // No API calls should have been made
    expect(mock.callLog).toHaveLength(0);

    // Complete message with cancelled flag sent to bob
    const bobMsg = await mq.receiveNonBlocking("bob");
    expect(bobMsg).not.toBeNull();
    expect(bobMsg!.type).toBe("complete");
    expect(bobMsg!.content).toContain("cancelled");

    // Cancellation state file written
    const state = await readIterationState(`${tmpDir}/${agentId}`, 1, "reflect");
    expect(state).not.toBeNull();
  });
});

describe("token budget", () => {
  test("stops when token budget is exhausted", async () => {
    const config = makeConfig({ maxIterations: 10, tokenBudget: 200 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    await mq.send({
      id: "msg-1", from: "bob", to: agentId,
      type: "task", content: "Work", timestamp: Date.now(),
    });

    // Each call uses 150 tokens — budget of 200 will be exceeded after first iteration
    const bigTokens = { input: 100, output: 50 };
    mock.addResponse(() => planResponse("plan", "complex"));
    mock.addResponse(() => textResponse("done", bigTokens));
    mock.addResponse(() => reflectResponse("continue", { nextMessage: "more" }));

    await runLifeLoop(config, deps);

    // Should have run exactly 1 iteration (3 calls) then stopped
    expect(mock.callLog).toHaveLength(3);
  });
});

describe("max iterations", () => {
  test("stops at maxIterations", async () => {
    const config = makeConfig({ maxIterations: 2 });
    const mock = createMockClient();
    const deps = makeDeps(mock);

    await mq.send({
      id: "msg-1", from: "bob", to: agentId,
      type: "task", content: "Work", timestamp: Date.now(),
    });

    // Iteration 1: continue
    mock.addResponse(() => planResponse("plan 1", "complex"));
    mock.addResponse(() => textResponse("exec 1"));
    mock.addResponse(() => reflectResponse("continue", { nextMessage: "do more" }));

    // Iteration 2: continue (but won't get to iteration 3)
    mock.addResponse(() => planResponse("plan 2", "complex"));
    mock.addResponse(() => textResponse("exec 2"));
    mock.addResponse(() => reflectResponse("continue", { nextMessage: "keep going" }));

    await runLifeLoop(config, deps);

    // 2 iterations × 3 calls = 6
    expect(mock.callLog).toHaveLength(6);
  });
});
