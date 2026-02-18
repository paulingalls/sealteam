import { RedisClient } from "bun";
import { readSessionState } from "./state-manager.ts";
import type { QueueMessage } from "./types.ts";
import { logRetry } from "./logger.ts";

const MQ_MAX_RETRIES = 3;
const MQ_BASE_DELAY_MS = 500;

function queueKey(name: string): string {
  return `queue:${name}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MessageQueue {
  private redis: RedisClient;

  constructor(valkeyUrl?: string) {
    this.redis = new RedisClient(valkeyUrl);
  }

  /**
   * Send a message with retry. Routes based on `message.to`:
   * - "shared" → fan-out to all active agents (except sender)
   * - "main"   → push to queue:main
   * - other    → push to queue:{name}
   */
  async send(
    message: QueueMessage,
    workspacePath?: string,
  ): Promise<void> {
    if (message.to === "shared") {
      if (!workspacePath) {
        throw new Error(
          "workspacePath is required for shared messages (needed to read session.json)",
        );
      }
      await this.sendShared(message, workspacePath);
      return;
    }

    await this.withRetry("send", async () => {
      const key = queueKey(message.to);
      await this.redis.lpush(key, JSON.stringify(message));
    });
  }

  /**
   * Fan-out: read session.json for active agents, push a copy to each
   * agent's personal queue (excluding the sender).
   */
  private async sendShared(
    message: QueueMessage,
    workspacePath: string,
  ): Promise<void> {
    const session = await readSessionState(workspacePath);
    if (!session) {
      throw new Error(
        `Cannot fan-out shared message: session.json not found in ${workspacePath}`,
      );
    }

    const activeAgents = session.agents.filter(
      (a) => a.status === "running" && a.config.name !== message.from,
    );

    const promises = activeAgents.map((agent) => {
      const copy: QueueMessage = { ...message, to: agent.config.name };
      return this.withRetry("send-shared", () =>
        this.redis.lpush(
          queueKey(agent.config.name),
          JSON.stringify(copy),
        ),
      );
    });

    await Promise.all(promises);
  }

  /**
   * Blocking pop from an agent's personal queue with retry.
   * Returns null if no message arrives within `timeoutSeconds`.
   */
  async receive(
    agentName: string,
    timeoutSeconds: number = 5,
  ): Promise<QueueMessage | null> {
    return this.withRetry("receive", async () => {
      const key = queueKey(agentName);
      const result = await this.redis.brpop(key, timeoutSeconds);
      if (!result) return null;
      // brpop returns [key, value]
      return JSON.parse(result[1]) as QueueMessage;
    });
  }

  /**
   * Non-blocking pop from an agent's personal queue with retry.
   * Returns null immediately if the queue is empty.
   */
  async receiveNonBlocking(
    agentName: string,
  ): Promise<QueueMessage | null> {
    return this.withRetry("receiveNonBlocking", async () => {
      const key = queueKey(agentName);
      const result = await this.redis.rpop(key);
      if (!result) return null;
      return JSON.parse(result) as QueueMessage;
    });
  }

  /**
   * Close the Redis connection.
   */
  close(): void {
    this.redis.close();
  }

  /**
   * Execute a Valkey operation with exponential backoff retry.
   */
  private async withRetry<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MQ_MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < MQ_MAX_RETRIES) {
          const delayMs = MQ_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logRetry(`Valkey ${operation}`, attempt, MQ_MAX_RETRIES, delayMs);
          await sleep(delayMs);
        }
      }
    }

    throw lastError ?? new Error(`Valkey ${operation} failed after retries`);
  }
}
