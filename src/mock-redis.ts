import type { RedisLike } from "./message-queue.ts";

/**
 * In-memory mock of the Redis operations used by MessageQueue.
 * Use this in tests instead of connecting to a real Valkey server.
 */
export class MockRedis implements RedisLike {
  private data = new Map<string, string[]>();

  async lpush(key: string, value: string): Promise<number> {
    let list = this.data.get(key);
    if (!list) {
      list = [];
      this.data.set(key, list);
    }
    list.unshift(value);
    return list.length;
  }

  async brpop(key: string, _timeout: number): Promise<[string, string] | null> {
    const list = this.data.get(key);
    if (!list || list.length === 0) return null;
    const value = list.pop()!;
    if (list.length === 0) this.data.delete(key);
    return [key, value];
  }

  async rpop(key: string): Promise<string | null> {
    const list = this.data.get(key);
    if (!list || list.length === 0) return null;
    const value = list.pop()!;
    if (list.length === 0) this.data.delete(key);
    return value;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return [...this.data.keys()].filter((k) => regex.test(k));
  }

  async del(key: string): Promise<number> {
    return this.data.delete(key) ? 1 : 0;
  }

  close(): void {
    // no-op
  }
}
