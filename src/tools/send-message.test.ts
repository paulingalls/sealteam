import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { definition, createHandler } from "./send-message.ts";
import { MessageQueue } from "../message-queue.ts";
import { MockRedis } from "../mock-redis.ts";
import { writeSessionState } from "../state-manager.ts";
import type { SessionState } from "../types.ts";

const prefix = `test-${crypto.randomUUID().slice(0, 8)}`;
let tmpDir: string;
let mq: MessageQueue;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-sendmsg-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}`.quiet();
  mq = new MessageQueue(new MockRedis());
});

afterEach(async () => {
  mq.close();
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("send-message tool", () => {
  test("definition has correct name", () => {
    expect(definition.name).toBe("send-message");
  });

  test("sends direct message to agent queue", async () => {
    const agentName = `${prefix}-bob`;
    const recipientName = `${prefix}-alice`;
    const handler = createHandler(agentName, mq, tmpDir);

    const result = await handler({
      to: recipientName,
      type: "task",
      content: "Build the API",
    });

    expect(result).toContain("Message sent");
    expect(result).toContain(recipientName);

    // Verify message is in the queue
    const msg = await mq.receiveNonBlocking(recipientName);
    expect(msg).not.toBeNull();
    expect(msg!.from).toBe(agentName);
    expect(msg!.content).toBe("Build the API");
    expect(msg!.type).toBe("task");
  });

  test("sends shared message via fan-out", async () => {
    const bobName = `${prefix}-bob`;
    const aliceName = `${prefix}-alice`;

    // Write session state with active agents
    const session: SessionState = {
      goal: "test",
      startTime: Date.now(),
      workspace: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      agents: [
        {
          config: {
            name: bobName,
            role: "leader",
            purpose: "lead",
            tools: [],
            model: "test",
            tokenBudget: 100,
            maxIterations: 10,
            workspacePath: tmpDir,
            valkeyUrl: "valkey://localhost:6379",
          },
          pid: 1,
          status: "running",
          startTime: Date.now(),
        },
        {
          config: {
            name: aliceName,
            role: "worker",
            purpose: "work",
            tools: [],
            model: "test",
            tokenBudget: 100,
            maxIterations: 10,
            workspacePath: tmpDir,
            valkeyUrl: "valkey://localhost:6379",
          },
          pid: 2,
          status: "running",
          startTime: Date.now(),
        },
      ],
      status: "running",
    };
    await writeSessionState(tmpDir, session);

    const handler = createHandler(bobName, mq, tmpDir);
    await handler({
      to: "shared",
      type: "status",
      content: "Schema updated",
    });

    // Alice should receive it, Bob should not
    const aliceMsg = await mq.receiveNonBlocking(aliceName);
    const bobMsg = await mq.receiveNonBlocking(bobName);
    expect(aliceMsg).not.toBeNull();
    expect(aliceMsg!.content).toBe("Schema updated");
    expect(bobMsg).toBeNull();
  });
});
