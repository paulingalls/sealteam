import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import {
  logAgentStart,
  logIteration,
  logStepComplete,
  logToolCall,
  logComplete,
  logError,
  logRecovery,
  logEscalation,
  logCancel,
  logIdle,
  logBudgetExhausted,
  logMaxIterations,
  logRetry,
  logMainStart,
  logSpawnLeader,
  logMonitoring,
  logAllComplete,
  logMainMessage,
  logAgentCrash,
  logAgentRespawn,
  logShutdown,
  logShutdownComplete,
  printSummaryReport,
  formatDuration,
  stripAnsi,
} from "./logger.ts";
import type { AgentConfig, SessionState } from "./types.ts";

// ─── Test Helpers ─────────────────────────────────────────────────

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: "test-agent",
    role: "Test role",
    purpose: "Test purpose",
    tools: ["bash"],
    model: "claude-sonnet-4-20250514",
    tokenBudget: 100000,
    maxIterations: 50,
    workspacePath: "/tmp/sealteam-test-logger",
    valkeyUrl: "valkey://localhost:6379",
    ...overrides,
  };
}

describe("Logger", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ─── Agent Logging ────────────────────────────────────────────

  describe("logAgentStart", () => {
    test("logs agent name and model", () => {
      const config = makeConfig({ name: "alice" });
      logAgentStart(config);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("[alice]");
      expect(output).toContain("Starting");
      expect(output).toContain("claude-sonnet-4-20250514");
    });
  });

  describe("logIteration", () => {
    test("logs standard path", () => {
      const config = makeConfig();
      logIteration(config, 3, "standard");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Iteration");
      expect(output).toContain("3");
      expect(output).toContain("standard path");
    });

    test("logs fast path", () => {
      const config = makeConfig();
      logIteration(config, 5, "fast");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("5");
      expect(output).toContain("fast path");
    });
  });

  describe("logStepComplete", () => {
    test("logs step name and token counts", () => {
      const config = makeConfig();
      logStepComplete(config, "plan", { input: 1000, output: 500 });
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("plan");
      expect(output).toContain("1000");
      expect(output).toContain("500");
    });
  });

  describe("logToolCall", () => {
    test("logs tool name", () => {
      const config = makeConfig();
      logToolCall(config, "bash");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("tool:");
      expect(output).toContain("bash");
    });
  });

  describe("logComplete", () => {
    test("logs completion with summary", () => {
      const config = makeConfig();
      logComplete(config, "All tasks finished successfully");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Complete");
      expect(output).toContain("All tasks finished");
    });
  });

  describe("logError", () => {
    test("logs error to stderr", () => {
      const config = makeConfig();
      logError(config, "Something went wrong");
      const output = stripAnsi(errorSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Error");
      expect(output).toContain("Something went wrong");
    });
  });

  describe("logRecovery", () => {
    test("logs recovery attempt count", () => {
      const config = makeConfig();
      logRecovery(config, 2, 3);
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Self-recovery");
      expect(output).toContain("2/3");
    });
  });

  describe("logEscalation", () => {
    test("logs escalation details", () => {
      const config = makeConfig();
      logEscalation(config, "stuck on file conflict");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Escalating");
      expect(output).toContain("stuck on file conflict");
    });
  });

  describe("logCancel", () => {
    test("logs cancellation reason", () => {
      const config = makeConfig();
      logCancel(config, "user requested shutdown");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Cancelled");
      expect(output).toContain("user requested shutdown");
    });
  });

  describe("logIdle", () => {
    test("logs idle cycle count", () => {
      const config = makeConfig();
      logIdle(config, 15);
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Idle");
      expect(output).toContain("15");
    });
  });

  describe("logBudgetExhausted", () => {
    test("logs used and total budget", () => {
      const config = makeConfig();
      logBudgetExhausted(config, 100000, 100000);
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Budget exhausted");
      expect(output).toContain("100000");
    });
  });

  describe("logMaxIterations", () => {
    test("logs max iteration count", () => {
      const config = makeConfig();
      logMaxIterations(config, 50);
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Max iterations");
      expect(output).toContain("50");
    });
  });

  describe("logRetry", () => {
    test("logs retry context and timing", () => {
      logRetry("Claude API call", 1, 3, 1000);
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Retry");
      expect(output).toContain("Claude API call");
      expect(output).toContain("1/3");
      expect(output).toContain("1000ms");
    });
  });

  // ─── Main Process Logging ─────────────────────────────────────

  describe("logMainStart", () => {
    test("logs goal, workspace, and workers", () => {
      logMainStart("Build a website", "/tmp/workspace", 4);
      const allOutput = logSpy.mock.calls.map((c) => stripAnsi(c[0] as string)).join("\n");
      expect(allOutput).toContain("SealTeam");
      expect(allOutput).toContain("Build a website");
      expect(allOutput).toContain("/tmp/workspace");
      expect(allOutput).toContain("4");
    });
  });

  describe("logSpawnLeader", () => {
    test("logs bob spawn message", () => {
      logSpawnLeader();
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Spawning");
      expect(output).toContain("bob");
    });
  });

  describe("logMonitoring", () => {
    test("logs monitoring message", () => {
      logMonitoring();
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Monitoring");
    });
  });

  describe("logAllComplete", () => {
    test("logs completion content", () => {
      logAllComplete("Everything done");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("All work complete");
      expect(output).toContain("Everything done");
    });
  });

  describe("logMainMessage", () => {
    test("logs from, type, and content", () => {
      logMainMessage("alice", "status", "halfway done");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("alice");
      expect(output).toContain("status");
      expect(output).toContain("halfway done");
    });
  });

  describe("logAgentCrash", () => {
    test("logs agent name and exit code", () => {
      logAgentCrash("charlie", 137);
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Agent crashed");
      expect(output).toContain("charlie");
      expect(output).toContain("137");
    });
  });

  describe("logAgentRespawn", () => {
    test("logs respawn with resume point", () => {
      logAgentRespawn("alice", "3-reflect");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Re-spawning");
      expect(output).toContain("alice");
      expect(output).toContain("3-reflect");
    });

    test("logs respawn without resume point", () => {
      logAgentRespawn("alice");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Re-spawning");
      expect(output).toContain("alice");
    });
  });

  describe("logShutdown", () => {
    test("logs signal name", () => {
      logShutdown("SIGINT");
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("SIGINT");
    });
  });

  describe("logShutdownComplete", () => {
    test("logs shutdown complete", () => {
      logShutdownComplete();
      const output = stripAnsi(logSpy.mock.calls[0]![0] as string);
      expect(output).toContain("Shutdown complete");
    });
  });

  // ─── Summary Report ───────────────────────────────────────────

  describe("printSummaryReport", () => {
    test("prints session summary with agents", () => {
      const session: SessionState = {
        goal: "Build a CLI tool",
        startTime: Date.now() - 60000,
        workspace: "/tmp/workspace",
        valkeyUrl: "valkey://localhost:6379",
        status: "completed",
        agents: [
          {
            config: makeConfig({ name: "bob", role: "Team Leader" }),
            pid: 1234,
            status: "completed",
            startTime: Date.now() - 60000,
            endTime: Date.now(),
          },
          {
            config: makeConfig({ name: "alice", role: "Worker" }),
            pid: 5678,
            status: "completed",
            startTime: Date.now() - 45000,
            endTime: Date.now(),
          },
        ],
      };

      printSummaryReport(session);
      const allOutput = logSpy.mock.calls.map((c) => stripAnsi(c[0] as string)).join("\n");
      expect(allOutput).toContain("SealTeam Summary");
      expect(allOutput).toContain("Build a CLI tool");
      expect(allOutput).toContain("completed");
      expect(allOutput).toContain("bob");
      expect(allOutput).toContain("alice");
    });

    test("handles running agents", () => {
      const session: SessionState = {
        goal: "Test goal",
        startTime: Date.now() - 10000,
        workspace: "/tmp/ws",
        valkeyUrl: "valkey://localhost:6379",
        status: "running",
        agents: [
          {
            config: makeConfig({ name: "bob", role: "Leader" }),
            pid: 1234,
            status: "running",
            startTime: Date.now() - 10000,
          },
        ],
      };

      printSummaryReport(session);
      const allOutput = logSpy.mock.calls.map((c) => stripAnsi(c[0] as string)).join("\n");
      expect(allOutput).toContain("still running");
    });
  });

  // ─── Utility Functions ────────────────────────────────────────

  describe("formatDuration", () => {
    test("formats seconds only", () => {
      expect(formatDuration(5000)).toBe("5s");
    });

    test("formats minutes and seconds", () => {
      expect(formatDuration(125000)).toBe("2m 5s");
    });

    test("formats hours, minutes, and seconds", () => {
      expect(formatDuration(3661000)).toBe("1h 1m 1s");
    });

    test("handles zero", () => {
      expect(formatDuration(0)).toBe("0s");
    });
  });

  describe("stripAnsi", () => {
    test("removes ANSI color codes", () => {
      const colored = "\x1b[31mError\x1b[0m: something";
      expect(stripAnsi(colored)).toBe("Error: something");
    });

    test("handles string with no ANSI codes", () => {
      expect(stripAnsi("plain text")).toBe("plain text");
    });

    test("removes bold and dim codes", () => {
      const styled = "\x1b[1mBold\x1b[0m and \x1b[2mDim\x1b[0m";
      expect(stripAnsi(styled)).toBe("Bold and Dim");
    });
  });
});
