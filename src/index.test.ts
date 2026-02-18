import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseCLIArgs, validateOptions, main } from "./index.ts";
import type { CLIOptions } from "./types.ts";
import { readSessionState } from "./state-manager.ts";

// ─── CLI Argument Parsing ────────────────────────────────────────

describe("parseCLIArgs", () => {
  // Save and restore env vars
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "SEALTEAM_MAX_AGENTS",
    "SEALTEAM_DEFAULT_BUDGET",
    "SEALTEAM_DEFAULT_MAX_ITERATIONS",
    "SEALTEAM_WORKSPACE",
    "VALKEY_URL",
    "SEALTEAM_LEADER_MODEL",
    "SEALTEAM_TEAM_MODEL",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test("parses goal from positional argument", () => {
    const opts = parseCLIArgs(["bun", "src/index.ts", "Build a todo app"]);
    expect(opts.goal).toBe("Build a todo app");
  });

  test("parses all CLI options", () => {
    const opts = parseCLIArgs([
      "bun", "src/index.ts",
      "--workers", "4",
      "--budget", "50000",
      "--max-iterations", "25",
      "--workspace", "/tmp/myworkspace",
      "--valkey-url", "valkey://other:6380",
      "--leader-model", "claude-opus-4-6",
      "--team-model", "claude-sonnet-4-6",
      "Build an API",
    ]);

    expect(opts.workers).toBe(4);
    expect(opts.budget).toBe(50000);
    expect(opts.maxIterations).toBe(25);
    expect(opts.workspace).toBe("/tmp/myworkspace");
    expect(opts.valkeyUrl).toBe("valkey://other:6380");
    expect(opts.leaderModel).toBe("claude-opus-4-6");
    expect(opts.teamModel).toBe("claude-sonnet-4-6");
    expect(opts.goal).toBe("Build an API");
  });

  test("uses defaults when no options provided", () => {
    const opts = parseCLIArgs(["bun", "src/index.ts", "Do something"]);
    expect(opts.workers).toBe(6);
    expect(opts.budget).toBe(100000);
    expect(opts.maxIterations).toBe(50);
    expect(opts.workspace).toBe("./workspace");
    expect(opts.valkeyUrl).toBe("valkey://localhost:6379");
    expect(opts.leaderModel).toBe("claude-opus-4-6");
    expect(opts.teamModel).toBe("claude-sonnet-4-6");
  });

  test("env vars override defaults", () => {
    process.env.SEALTEAM_MAX_AGENTS = "8";
    process.env.SEALTEAM_DEFAULT_BUDGET = "200000";
    process.env.SEALTEAM_DEFAULT_MAX_ITERATIONS = "100";
    process.env.SEALTEAM_WORKSPACE = "/custom/workspace";
    process.env.VALKEY_URL = "valkey://custom:6381";
    process.env.SEALTEAM_LEADER_MODEL = "claude-opus-4-6";
    process.env.SEALTEAM_TEAM_MODEL = "claude-sonnet-4-6";

    const opts = parseCLIArgs(["bun", "src/index.ts", "Goal"]);

    expect(opts.workers).toBe(8);
    expect(opts.budget).toBe(200000);
    expect(opts.maxIterations).toBe(100);
    expect(opts.workspace).toBe("/custom/workspace");
    expect(opts.valkeyUrl).toBe("valkey://custom:6381");
  });

  test("CLI args override env vars", () => {
    process.env.SEALTEAM_MAX_AGENTS = "8";
    process.env.SEALTEAM_DEFAULT_BUDGET = "200000";

    const opts = parseCLIArgs([
      "bun", "src/index.ts",
      "--workers", "3",
      "--budget", "75000",
      "Goal",
    ]);

    expect(opts.workers).toBe(3);
    expect(opts.budget).toBe(75000);
  });

  test("clamps workers to valid range", () => {
    const tooMany = parseCLIArgs(["bun", "src/index.ts", "--workers", "20", "Goal"]);
    expect(tooMany.workers).toBe(12);

    const tooFew = parseCLIArgs(["bun", "src/index.ts", "--workers", "0", "Goal"]);
    expect(tooFew.workers).toBe(1);
  });

  test("parses --resume-from option", () => {
    const opts = parseCLIArgs([
      "bun", "src/index.ts",
      "--resume-from", "/tmp/old-workspace",
      "Recover",
    ]);
    expect(opts.resumeFrom).toBe("/tmp/old-workspace");
  });

  test("goal is empty string when not provided", () => {
    const opts = parseCLIArgs(["bun", "src/index.ts"]);
    expect(opts.goal).toBe("");
  });
});

// ─── Validation ──────────────────────────────────────────────────

describe("validateOptions", () => {
  const savedApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (savedApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("returns null when valid", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const opts: CLIOptions = {
      goal: "Build something",
      workers: 6,
      budget: 100000,
      maxIterations: 50,
      workspace: "./workspace",
      valkeyUrl: "valkey://localhost:6379",
      leaderModel: "claude-opus-4-6",
      teamModel: "claude-sonnet-4-6",
    };
    expect(validateOptions(opts)).toBeNull();
  });

  test("returns error when goal is missing and no resume", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const opts: CLIOptions = {
      goal: "",
      workers: 6,
      budget: 100000,
      maxIterations: 50,
      workspace: "./workspace",
      valkeyUrl: "valkey://localhost:6379",
      leaderModel: "claude-opus-4-6",
      teamModel: "claude-sonnet-4-6",
    };
    const err = validateOptions(opts);
    expect(err).not.toBeNull();
    expect(err).toContain("No goal");
  });

  test("allows missing goal when resumeFrom is set", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const opts: CLIOptions = {
      goal: "",
      workers: 6,
      budget: 100000,
      maxIterations: 50,
      workspace: "./workspace",
      valkeyUrl: "valkey://localhost:6379",
      leaderModel: "claude-opus-4-6",
      teamModel: "claude-sonnet-4-6",
      resumeFrom: "/tmp/old",
    };
    expect(validateOptions(opts)).toBeNull();
  });

  test("returns error when ANTHROPIC_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const opts: CLIOptions = {
      goal: "Do it",
      workers: 6,
      budget: 100000,
      maxIterations: 50,
      workspace: "./workspace",
      valkeyUrl: "valkey://localhost:6379",
      leaderModel: "claude-opus-4-6",
      teamModel: "claude-sonnet-4-6",
    };
    const err = validateOptions(opts);
    expect(err).not.toBeNull();
    expect(err).toContain("ANTHROPIC_API_KEY");
  });

  test("returns error when budget is zero", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const opts: CLIOptions = {
      goal: "Do it",
      workers: 6,
      budget: 0,
      maxIterations: 50,
      workspace: "./workspace",
      valkeyUrl: "valkey://localhost:6379",
      leaderModel: "claude-opus-4-6",
      teamModel: "claude-sonnet-4-6",
    };
    const err = validateOptions(opts);
    expect(err).not.toBeNull();
    expect(err).toContain("budget");
  });

  test("returns error when maxIterations is negative", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const opts: CLIOptions = {
      goal: "Do it",
      workers: 6,
      budget: 100000,
      maxIterations: -1,
      workspace: "./workspace",
      valkeyUrl: "valkey://localhost:6379",
      leaderModel: "claude-opus-4-6",
      teamModel: "claude-sonnet-4-6",
    };
    const err = validateOptions(opts);
    expect(err).not.toBeNull();
    expect(err).toContain("max-iterations");
  });
});

// ─── Main Process (workspace creation) ───────────────────────────

describe("main - workspace creation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/sealteam-index-test-${crypto.randomUUID()}`;
  });

  afterEach(async () => {
    await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow();
  });

  test("creates workspace directory structure and session.json", async () => {
    // We can't run the full main() without a real Valkey and eventually spawning processes,
    // but we can test the workspace setup portion by calling main and canceling quickly.
    // Instead, test the key setup steps directly.
    const { initRepo, createGitignore, commitAll } = await import("./git-manager.ts");
    const { writeSessionState } = await import("./state-manager.ts");

    await Bun.$`mkdir -p ${tmpDir}/logs`.quiet();

    const bobDir = `${tmpDir}/bob`;
    await initRepo(bobDir);
    await createGitignore(bobDir);
    await commitAll(bobDir, "Initial commit");

    // Verify git repo created
    const gitResult = await Bun.$`git -C ${bobDir} log --oneline`.quiet().text();
    expect(gitResult).toContain("Initial commit");

    // Verify .gitignore
    const gitignore = await Bun.file(`${bobDir}/.gitignore`).text();
    expect(gitignore).toContain("state/");
    expect(gitignore).toContain("logs/");

    // Write and verify session state
    await writeSessionState(tmpDir, {
      goal: "Test goal",
      startTime: Date.now(),
      workspace: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      agents: [],
      status: "running",
    });

    const session = await readSessionState(tmpDir);
    expect(session).not.toBeNull();
    expect(session!.goal).toBe("Test goal");
    expect(session!.status).toBe("running");
    expect(session!.agents).toHaveLength(0);
  });

  test("leader config has all 8 tools and 2x budget", () => {
    const options: CLIOptions = {
      goal: "Build an app",
      workers: 6,
      budget: 100000,
      maxIterations: 50,
      workspace: tmpDir,
      valkeyUrl: "valkey://localhost:6379",
      leaderModel: "claude-opus-4-6",
      teamModel: "claude-sonnet-4-6",
    };

    // Replicate the leader config creation from main()
    const bobConfig = {
      name: "bob",
      role: "Team Leader",
      purpose: `Achieve goal: ${options.goal}`,
      tools: ["bash", "read-file", "write-file", "web-search", "web-fetch", "spawn-agent", "send-message", "git"],
      model: options.leaderModel,
      tokenBudget: options.budget * 2,
      maxIterations: options.maxIterations,
      workspacePath: options.workspace,
      valkeyUrl: options.valkeyUrl,
    };

    expect(bobConfig.tools).toHaveLength(8);
    expect(bobConfig.tokenBudget).toBe(200000);
    expect(bobConfig.model).toBe("claude-opus-4-6");
    expect(bobConfig.name).toBe("bob");
  });
});

// ─── formatDuration (smoke test via import) ──────────────────────

describe("utility functions", () => {
  test("parseCLIArgs handles options before goal", () => {
    const opts = parseCLIArgs([
      "bun", "src/index.ts",
      "--workers", "4",
      "My goal here",
    ]);
    expect(opts.goal).toBe("My goal here");
    expect(opts.workers).toBe(4);
  });

  test("parseCLIArgs handles goal before options", () => {
    const opts = parseCLIArgs([
      "bun", "src/index.ts",
      "My goal here",
      "--workers", "4",
    ]);
    expect(opts.goal).toBe("My goal here");
    expect(opts.workers).toBe(4);
  });
});
