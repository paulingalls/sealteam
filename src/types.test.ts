import { test, expect } from "bun:test";
import type {
  QueueMessage,
  AgentConfig,
  IterationState,
  ReflectDecision,
  IterationSummary,
  SessionState,
  AgentSessionEntry,
  ToolDefinition,
  ToolModule,
  ToolRegistryEntry,
  CLIOptions,
  TokenUsage,
} from "./types.ts";

test("QueueMessage conforms to interface", () => {
  const msg: QueueMessage = {
    id: "msg-001",
    from: "bob",
    to: "alice",
    type: "task",
    content: "Build the API",
    timestamp: Date.now(),
  };
  expect(msg.id).toBe("msg-001");
  expect(msg.type).toBe("task");
});

test("QueueMessage supports all message types", () => {
  const types: QueueMessage["type"][] = [
    "task",
    "status",
    "review",
    "complete",
    "error",
    "cancel",
    "all-complete",
  ];
  for (const type of types) {
    const msg: QueueMessage = {
      id: "msg",
      from: "a",
      to: "b",
      type,
      content: "",
      timestamp: 0,
    };
    expect(msg.type).toBe(type);
  }
});

test("AgentConfig conforms to interface", () => {
  const config: AgentConfig = {
    name: "alice",
    role: "backend engineer",
    purpose: "Build the REST API with authentication",
    tools: ["bash", "read-file", "write-file", "git"],
    model: "claude-sonnet-4-20250514",
    tokenBudget: 100000,
    maxIterations: 50,
    workspacePath: "./workspace",
    valkeyUrl: "valkey://localhost:6379",
  };
  expect(config.name).toBe("alice");
  expect(config.tools).toHaveLength(4);
});

test("IterationState conforms to interface", () => {
  const state: IterationState = {
    iteration: 1,
    step: "plan",
    timestamp: Date.now(),
    input: { message: "Build the API" },
    output: { plan: "First, set up the project structure" },
    tokensUsed: { input: 500, output: 200 },
    complexity: "complex",
  };
  expect(state.iteration).toBe(1);
  expect(state.step).toBe("plan");
  expect(state.complexity).toBe("complex");
});

test("IterationState supports all step types", () => {
  const steps: IterationState["step"][] = [
    "plan",
    "execute",
    "plan-execute",
    "reflect",
  ];
  for (const step of steps) {
    const state: IterationState = {
      iteration: 1,
      step,
      timestamp: 0,
      input: null,
      output: null,
      tokensUsed: { input: 0, output: 0 },
    };
    expect(state.step).toBe(step);
  }
});

test("ReflectDecision conforms to interface", () => {
  const decision: ReflectDecision = {
    decision: "continue",
    summary: {
      iteration: 1,
      plan: "Set up project structure",
      outcome: "Created package.json and tsconfig.json",
      filesChanged: ["package.json", "tsconfig.json"],
      decisions: ["Using Bun as the runtime"],
    },
    nextMessage: "Now implement the API routes",
  };
  expect(decision.decision).toBe("continue");
  expect(decision.summary.filesChanged).toHaveLength(2);
});

test("ReflectDecision supports error with recovery", () => {
  const decision: ReflectDecision = {
    decision: "error",
    summary: {
      iteration: 3,
      plan: "Run tests",
      outcome: "Tests failed due to missing dependency",
      filesChanged: [],
      decisions: ["Need to install missing package"],
    },
    errorDetails: "Module not found: @foo/bar",
    selfRecoveryAttempt: 2,
  };
  expect(decision.decision).toBe("error");
  expect(decision.selfRecoveryAttempt).toBe(2);
});

test("SessionState conforms to interface", () => {
  const agentEntry: AgentSessionEntry = {
    config: {
      name: "bob",
      role: "team leader",
      purpose: "Lead the team",
      tools: ["bash", "spawn-agent", "send-message"],
      model: "claude-opus-4-20250514",
      tokenBudget: 200000,
      maxIterations: 50,
      workspacePath: "./workspace",
      valkeyUrl: "valkey://localhost:6379",
    },
    pid: 12345,
    status: "running",
    startTime: Date.now(),
  };

  const session: SessionState = {
    goal: "Build a REST API",
    startTime: Date.now(),
    workspace: "./workspace",
    valkeyUrl: "valkey://localhost:6379",
    agents: [agentEntry],
    status: "running",
  };
  expect(session.agents).toHaveLength(1);
  expect(session.agents[0]!.config.name).toBe("bob");
});

test("AgentSessionEntry supports all statuses", () => {
  const statuses: AgentSessionEntry["status"][] = [
    "running",
    "completed",
    "failed",
    "cancelled",
  ];
  for (const status of statuses) {
    const entry: AgentSessionEntry = {
      config: {
        name: "test",
        role: "test",
        purpose: "test",
        tools: [],
        model: "claude-sonnet-4-20250514",
        tokenBudget: 100000,
        maxIterations: 50,
        workspacePath: ".",
        valkeyUrl: "valkey://localhost:6379",
      },
      pid: 1,
      status,
      startTime: 0,
    };
    expect(entry.status).toBe(status);
  }
});

test("ToolDefinition conforms to interface", () => {
  const def: ToolDefinition = {
    name: "bash",
    description: "Execute shell commands",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
      },
      required: ["command"],
    },
  };
  expect(def.name).toBe("bash");
});

test("ToolModule conforms to interface", () => {
  const mod: ToolModule = {
    definition: {
      name: "test-tool",
      description: "A test tool",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (_input) => "result",
  };
  expect(mod.definition.name).toBe("test-tool");
  expect(typeof mod.handler).toBe("function");
});

test("ToolModule handler returns string", async () => {
  const mod: ToolModule = {
    definition: {
      name: "echo",
      description: "Echo input",
      input_schema: { type: "object", properties: {} },
    },
    handler: async (input) => JSON.stringify(input),
  };
  const result = await mod.handler({ message: "hello" });
  expect(typeof result).toBe("string");
  expect(result).toBe('{"message":"hello"}');
});

test("ToolRegistryEntry conforms to interface", () => {
  const entry: ToolRegistryEntry = {
    name: "my-tool",
    path: "tools/my-tool.ts",
    status: "active",
    validatedAt: Date.now(),
  };
  expect(entry.status).toBe("active");

  const disabled: ToolRegistryEntry = {
    name: "bad-tool",
    path: "tools/bad-tool.ts",
    status: "disabled",
    error: "Security scan failed: eval() detected",
  };
  expect(disabled.status).toBe("disabled");
  expect(disabled.error).toBeDefined();
});

test("CLIOptions conforms to interface", () => {
  const opts: CLIOptions = {
    goal: "Build a REST API with authentication",
    workers: 6,
    budget: 100000,
    maxIterations: 50,
    workspace: "./workspace",
    valkeyUrl: "valkey://localhost:6379",
    leaderModel: "claude-opus-4-20250514",
    teamModel: "claude-sonnet-4-20250514",
  };
  expect(opts.goal).toContain("REST API");
  expect(opts.workers).toBe(6);
});

test("CLIOptions supports optional resumeFrom", () => {
  const opts: CLIOptions = {
    goal: "Resume task",
    workers: 6,
    budget: 100000,
    maxIterations: 50,
    workspace: "./workspace",
    valkeyUrl: "valkey://localhost:6379",
    leaderModel: "claude-opus-4-20250514",
    teamModel: "claude-sonnet-4-20250514",
    resumeFrom: "3-execute",
  };
  expect(opts.resumeFrom).toBe("3-execute");
});

test("TokenUsage conforms to interface", () => {
  const usage: TokenUsage = { input: 1500, output: 500 };
  expect(usage.input + usage.output).toBe(2000);
});
