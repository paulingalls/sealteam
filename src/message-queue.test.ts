import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { MessageQueue } from "./message-queue.ts";
import { writeSessionState } from "./state-manager.ts";
import type { QueueMessage, SessionState, AgentConfig } from "./types.ts";

// Unique prefix per test run to avoid collisions
const prefix = `test-${crypto.randomUUID().slice(0, 8)}`;
let mq: MessageQueue;
let tmpDir: string;

function agentName(name: string): string {
  return `${prefix}-${name}`;
}

function makeMessage(
  from: string,
  to: string,
  content: string = "test",
): QueueMessage {
  return {
    id: crypto.randomUUID(),
    from: agentName(from),
    to: to === "shared" || to === "main" ? to : agentName(to),
    type: "task",
    content,
    timestamp: Date.now(),
  };
}

function makeAgentConfig(name: string): AgentConfig {
  return {
    name: agentName(name),
    role: "test agent",
    purpose: "testing",
    tools: [],
    model: "claude-sonnet-4-20250514",
    tokenBudget: 100000,
    maxIterations: 50,
    workspacePath: tmpDir,
    valkeyUrl: "valkey://localhost:6379",
  };
}

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-mq-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}`.quiet();
  mq = new MessageQueue("valkey://localhost:6379");
});

afterEach(async () => {
  mq.close();
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("send and receive", () => {
  test("round-trip: send then receive", async () => {
    const msg = makeMessage("bob", "alice", "hello alice");

    await mq.send(msg);
    const received = await mq.receive(agentName("alice"), 1);

    expect(received).not.toBeNull();
    expect(received!.from).toBe(agentName("bob"));
    expect(received!.content).toBe("hello alice");
    expect(received!.type).toBe("task");
  });

  test("receive returns null on timeout (empty queue)", async () => {
    const received = await mq.receive(agentName("nobody"), 1);
    expect(received).toBeNull();
  });

  test("non-blocking receive returns null on empty queue", async () => {
    const received = await mq.receiveNonBlocking(agentName("nobody"));
    expect(received).toBeNull();
  });

  test("non-blocking receive returns message when available", async () => {
    const msg = makeMessage("bob", "charlie", "quick check");
    await mq.send(msg);

    const received = await mq.receiveNonBlocking(agentName("charlie"));
    expect(received).not.toBeNull();
    expect(received!.content).toBe("quick check");
  });

  test("FIFO order: messages received in order sent", async () => {
    const msg1 = makeMessage("bob", "alice", "first");
    const msg2 = makeMessage("bob", "alice", "second");
    const msg3 = makeMessage("bob", "alice", "third");

    await mq.send(msg1);
    await mq.send(msg2);
    await mq.send(msg3);

    const r1 = await mq.receive(agentName("alice"), 1);
    const r2 = await mq.receive(agentName("alice"), 1);
    const r3 = await mq.receive(agentName("alice"), 1);

    expect(r1!.content).toBe("first");
    expect(r2!.content).toBe("second");
    expect(r3!.content).toBe("third");
  });

  test("send to main queue", async () => {
    // Use a prefixed main queue name to avoid collisions
    const msg: QueueMessage = {
      id: crypto.randomUUID(),
      from: agentName("bob"),
      to: "main",
      type: "all-complete",
      content: "done",
      timestamp: Date.now(),
    };

    await mq.send(msg);
    const received = await mq.receive("main", 1);

    expect(received).not.toBeNull();
    expect(received!.type).toBe("all-complete");
    expect(received!.content).toBe("done");
  });
});

describe("shared fan-out", () => {
  test("fan-out sends to all active agents except sender", async () => {
    const session: SessionState = {
      goal: "test",
      startTime: Date.now(),
      workspace: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      agents: [
        { config: makeAgentConfig("bob"), pid: 1, status: "running", startTime: Date.now() },
        { config: makeAgentConfig("alice"), pid: 2, status: "running", startTime: Date.now() },
        { config: makeAgentConfig("charlie"), pid: 3, status: "running", startTime: Date.now() },
      ],
      status: "running",
    };
    await writeSessionState(tmpDir, session);

    const msg = makeMessage("bob", "shared", "API schema finalized");
    await mq.send(msg, tmpDir);

    // alice and charlie should receive it, bob should not
    const aliceMsg = await mq.receiveNonBlocking(agentName("alice"));
    const charlieMsg = await mq.receiveNonBlocking(agentName("charlie"));
    const bobMsg = await mq.receiveNonBlocking(agentName("bob"));

    expect(aliceMsg).not.toBeNull();
    expect(aliceMsg!.content).toBe("API schema finalized");
    expect(charlieMsg).not.toBeNull();
    expect(charlieMsg!.content).toBe("API schema finalized");
    expect(bobMsg).toBeNull();
  });

  test("fan-out skips completed agents", async () => {
    const session: SessionState = {
      goal: "test",
      startTime: Date.now(),
      workspace: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      agents: [
        { config: makeAgentConfig("bob"), pid: 1, status: "running", startTime: Date.now() },
        { config: makeAgentConfig("alice"), pid: 2, status: "completed", startTime: Date.now(), endTime: Date.now() },
        { config: makeAgentConfig("charlie"), pid: 3, status: "running", startTime: Date.now() },
      ],
      status: "running",
    };
    await writeSessionState(tmpDir, session);

    const msg = makeMessage("bob", "shared", "update");
    await mq.send(msg, tmpDir);

    const aliceMsg = await mq.receiveNonBlocking(agentName("alice"));
    const charlieMsg = await mq.receiveNonBlocking(agentName("charlie"));

    expect(aliceMsg).toBeNull(); // completed, should not receive
    expect(charlieMsg).not.toBeNull();
  });

  test("fan-out throws without workspacePath", async () => {
    const msg = makeMessage("bob", "shared", "test");
    expect(mq.send(msg)).rejects.toThrow("workspacePath is required");
  });

  test("fan-out throws when session.json missing", async () => {
    const msg = makeMessage("bob", "shared", "test");
    expect(mq.send(msg, "/tmp/nonexistent-dir")).rejects.toThrow(
      "session.json not found",
    );
  });
});
