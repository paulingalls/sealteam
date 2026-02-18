import { test, expect, describe } from "bun:test";
import { ContextManager } from "./context-manager.ts";
import type { IterationState, QueueMessage, IterationSummary } from "./types.ts";

function makeState(
  iteration: number,
  step: IterationState["step"],
  input: unknown = null,
  output: unknown = null,
): IterationState {
  return {
    iteration,
    step,
    timestamp: Date.now(),
    input,
    output,
    tokensUsed: { input: 100, output: 50 },
  };
}

function makeReflectState(
  iteration: number,
  summary: IterationSummary,
): IterationState {
  return makeState(iteration, "reflect", null, {
    decision: "continue",
    summary,
  });
}

function makeMessage(from: string, content: string): QueueMessage {
  return {
    id: crypto.randomUUID(),
    from,
    to: "test-agent",
    type: "task",
    content,
    timestamp: Date.now(),
  };
}

describe("ContextManager", () => {
  test("constructor sets context limit from model", () => {
    const cm = new ContextManager("claude-opus-4-20250514");
    expect(cm.getContextLimit()).toBe(200000);
  });

  test("assembleContext with fewer than 5 iterations returns all in full", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    const states: IterationState[] = [
      makeState(1, "plan", "plan input 1", "plan output 1"),
      makeState(1, "execute", "exec input 1", "exec output 1"),
      makeState(1, "reflect", "reflect input 1", "reflect output 1"),
      makeState(2, "plan", "plan input 2", "plan output 2"),
      makeState(2, "execute", "exec input 2", "exec output 2"),
    ];

    const messages = cm.assembleContext({
      iterationStates: states,
      currentMessages: [],
      currentIteration: 2,
    });

    // Each state produces 2 messages (user input + assistant output)
    // 5 states × 2 = 10 messages, no compacted summaries
    expect(messages).toHaveLength(10);

    // All should be full detail (contain actual content, not summaries)
    const firstContent = messages[0]!.content as string;
    expect(firstContent).toContain("Iteration 1 - plan input");
    expect(firstContent).toContain("plan input 1");
  });

  test("assembleContext compacts iterations older than 5", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    const states: IterationState[] = [];
    // Create 8 iterations with reflect summaries
    for (let i = 1; i <= 8; i++) {
      states.push(makeState(i, "plan", `plan ${i}`, `plan out ${i}`));
      states.push(makeState(i, "execute", `exec ${i}`, `exec out ${i}`));
      states.push(
        makeReflectState(i, {
          iteration: i,
          plan: `Plan for iteration ${i}`,
          outcome: `Outcome of iteration ${i}`,
          filesChanged: [`file${i}.ts`],
          decisions: [`decision ${i}`],
        }),
      );
    }

    const messages = cm.assembleContext({
      iterationStates: states,
      currentMessages: [],
      currentIteration: 8,
    });

    // Iterations 1-3 should be compacted (older than 8-5=3)
    // Each compacted iteration = 2 messages (summary + ack)
    // Iterations 4-8 should be full detail: 5 iters × 3 steps × 2 msgs = 30
    // Compacted: 3 × 2 = 6
    // Total = 36
    expect(messages).toHaveLength(36);

    // First messages should be compacted summaries
    const first = messages[0]!.content as string;
    expect(first).toContain("[Iteration 1 summary]");
    expect(first).toContain("Plan for iteration 1");
    expect(first).toContain("Outcome of iteration 1");
    expect(first).toContain("file1.ts");

    // Later messages should be full detail
    const fullDetailStart = 6; // after 3 compacted iterations × 2 messages
    const detailMsg = messages[fullDetailStart]!.content as string;
    expect(detailMsg).toContain("Iteration 4 - plan input");
  });

  test("assembleContext includes current queue messages", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    const messages = cm.assembleContext({
      iterationStates: [makeState(1, "plan", "input", "output")],
      currentMessages: [
        makeMessage("bob", "Please build the API"),
        makeMessage("alice", "I need help with tests"),
      ],
      currentIteration: 1,
    });

    // 1 state × 2 + 1 queue message block = 3
    expect(messages).toHaveLength(3);

    const lastMsg = messages[messages.length - 1]!.content as string;
    expect(lastMsg).toContain("bob");
    expect(lastMsg).toContain("Please build the API");
    expect(lastMsg).toContain("alice");
    expect(lastMsg).toContain("I need help with tests");
  });

  test("assembleContext with no messages and no states returns empty", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");
    const messages = cm.assembleContext({
      iterationStates: [],
      currentMessages: [],
      currentIteration: 1,
    });
    expect(messages).toHaveLength(0);
  });

  test("assembleContext with only queue messages", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");
    const messages = cm.assembleContext({
      iterationStates: [],
      currentMessages: [makeMessage("bob", "Start working")],
      currentIteration: 1,
    });
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as string)).toContain("Start working");
  });
});

describe("compaction triggers", () => {
  test("checkCompactionNeeded returns none at low utilization", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");
    // Default estimate is 0
    expect(cm.checkCompactionNeeded()).toBe("none");
  });

  test("checkCompactionNeeded returns soft at 70%+", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");
    // Context limit is 200000, so 70% = 140000 tokens
    cm.updateTokenUsage(145000);
    expect(cm.checkCompactionNeeded()).toBe("soft");
  });

  test("checkCompactionNeeded returns hard at 90%+", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");
    cm.updateTokenUsage(185000);
    expect(cm.checkCompactionNeeded()).toBe("hard");
  });

  test("getUtilization reflects updated token usage", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");
    cm.updateTokenUsage(100000);
    expect(cm.getUtilization()).toBe(0.5);
  });
});

describe("compactIterations", () => {
  test("keeps recent iterations unchanged", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    const states = [
      makeState(8, "plan", "detailed plan", "detailed output"),
      makeState(8, "execute", "detailed exec", { result: "long output" }),
    ];

    const compacted = cm.compactIterations(states, 8);
    expect(compacted[0]!.input).toBe("detailed plan");
    expect(compacted[0]!.output).toBe("detailed output");
    expect(compacted[1]!.input).toBe("detailed exec");
  });

  test("summarizes old iterations", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    const longInput = "x".repeat(1000);
    const states = [
      makeState(1, "plan", longInput, longInput),
    ];

    const compacted = cm.compactIterations(states, 10);
    // Iteration 1 is older than 10-5=5, so it should be summarized
    const input = compacted[0]!.input as string;
    expect(input.length).toBeLessThan(longInput.length);
    expect(input).toContain("...");
  });

  test("trims tool results for semi-old iterations", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    // 500 lines of output in a nested object
    const bigOutput = {
      result: Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"),
    };
    const states = [
      makeState(5, "execute", "exec input", bigOutput),
    ];

    const compacted = cm.compactIterations(states, 8);
    // Iteration 5 is within [8-5, 8-3] range, so tool results are trimmed
    // but not fully summarized
    const output = compacted[0]!.output as Record<string, string>;
    expect(output.result).toContain("lines omitted");
  });
});

describe("tool result trimming", () => {
  test("large text output gets trimmed", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    // Create a state with 1000 lines of output
    const bigText = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join("\n");
    const states = [
      makeState(1, "execute", null, { stdout: bigText }),
    ];

    // Iteration 1, current = 10 → iteration 1 is old enough for full summarization
    // Let's test semi-old (trim range): iteration 5, current = 8
    const semiOldStates = [
      makeState(5, "execute", null, { stdout: bigText }),
    ];

    const compacted = cm.compactIterations(semiOldStates, 8);
    const output = compacted[0]!.output as Record<string, string>;
    expect(output.stdout).toContain("line-0");
    expect(output.stdout).toContain("line-999");
    expect(output.stdout).toContain("lines omitted");
    expect(output.stdout!.split("\n").length).toBeLessThan(1000);
  });

  test("small text output is not trimmed", () => {
    const cm = new ContextManager("claude-sonnet-4-20250514");

    const smallText = "just a few lines\nof output\n";
    const states = [
      makeState(5, "execute", null, { stdout: smallText }),
    ];

    const compacted = cm.compactIterations(states, 8);
    const output = compacted[0]!.output as Record<string, string>;
    expect(output.stdout).toBe(smallText);
  });
});
