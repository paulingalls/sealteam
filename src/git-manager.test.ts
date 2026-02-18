import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  initRepo,
  createGitignore,
  commitAll,
  cloneForAgent,
  checkoutBranch,
  addRemoteAndFetch,
  getDiff,
  mergeAgentBranch,
  pullOriginMain,
  gitExec,
} from "./git-manager.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = `/tmp/sealteam-git-test-${crypto.randomUUID()}`;
  await Bun.$`mkdir -p ${tmpDir}`.quiet();
});

afterEach(async () => {
  await Bun.$`rm -rf ${tmpDir}`.quiet();
});

describe("initRepo", () => {
  test("creates a valid git repo", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);

    const dotGit = Bun.file(`${repoDir}/.git/HEAD`);
    expect(await dotGit.exists()).toBe(true);
  });

  test("sets user config", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);

    const email = await gitExec(repoDir, ["config", "user.email"]);
    expect(email.stdout).toBe("sealteam@local");
  });
});

describe("createGitignore", () => {
  test("creates .gitignore with state/ and logs/", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);
    await createGitignore(repoDir);

    const content = await Bun.file(`${repoDir}/.gitignore`).text();
    expect(content).toContain("state/");
    expect(content).toContain("logs/");
  });
});

describe("commitAll", () => {
  test("creates a commit", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);
    await createGitignore(repoDir);

    const result = await commitAll(repoDir, "Initial commit");
    expect(result.exitCode).toBe(0);

    const log = await gitExec(repoDir, ["log", "--oneline"]);
    expect(log.stdout).toContain("Initial commit");
  });

  test("commits multiple files", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);
    await Bun.write(`${repoDir}/file1.txt`, "hello");
    await Bun.write(`${repoDir}/file2.txt`, "world");

    await commitAll(repoDir, "Add two files");

    const log = await gitExec(repoDir, ["log", "--oneline"]);
    expect(log.stdout).toContain("Add two files");

    // Verify both files are tracked
    const ls = await gitExec(repoDir, ["ls-files"]);
    expect(ls.stdout).toContain("file1.txt");
    expect(ls.stdout).toContain("file2.txt");
  });
});

describe("cloneForAgent", () => {
  test("clones repo and creates agent branch", async () => {
    const leaderDir = `${tmpDir}/bob`;
    await initRepo(leaderDir);
    await createGitignore(leaderDir);
    await commitAll(leaderDir, "Initial commit");

    const agentDir = `${tmpDir}/alice`;
    await cloneForAgent(leaderDir, agentDir, "alice");

    // Verify clone exists
    expect(await Bun.file(`${agentDir}/.git/HEAD`).exists()).toBe(true);

    // Verify on the right branch
    const branch = await gitExec(agentDir, ["branch", "--show-current"]);
    expect(branch.stdout).toBe("agent/alice");

    // Verify .gitignore was cloned
    expect(await Bun.file(`${agentDir}/.gitignore`).exists()).toBe(true);
  });

  test("clone has leader as origin remote", async () => {
    const leaderDir = `${tmpDir}/bob`;
    await initRepo(leaderDir);
    await createGitignore(leaderDir);
    await commitAll(leaderDir, "Initial commit");

    const agentDir = `${tmpDir}/alice`;
    await cloneForAgent(leaderDir, agentDir, "alice");

    const remotes = await gitExec(agentDir, ["remote", "-v"]);
    expect(remotes.stdout).toContain("origin");
  });
});

describe("checkoutBranch", () => {
  test("creates and switches to new branch", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);
    await Bun.write(`${repoDir}/file.txt`, "x");
    await commitAll(repoDir, "Initial");

    const result = await checkoutBranch(repoDir, "feature/test");
    expect(result.exitCode).toBe(0);

    const branch = await gitExec(repoDir, ["branch", "--show-current"]);
    expect(branch.stdout).toBe("feature/test");
  });
});

describe("addRemoteAndFetch + getDiff + mergeAgentBranch", () => {
  test("full PR workflow: add remote, fetch, diff, merge", async () => {
    // Setup leader repo
    const leaderDir = `${tmpDir}/bob`;
    await initRepo(leaderDir);
    await createGitignore(leaderDir);
    await commitAll(leaderDir, "Initial commit");

    // Setup agent clone
    const agentDir = `${tmpDir}/alice`;
    await cloneForAgent(leaderDir, agentDir, "alice");

    // Agent does work on its branch
    await Bun.write(`${agentDir}/api.ts`, "export const handler = () => 'ok';");
    await commitAll(agentDir, "Add API handler");

    // Leader reviews: add remote, fetch, diff
    await addRemoteAndFetch(leaderDir, "alice", agentDir);

    const diff = await getDiff(leaderDir, "alice");
    expect(diff).toContain("api.ts");
    expect(diff).toContain("handler");

    // Leader merges
    const mergeResult = await mergeAgentBranch(leaderDir, "alice");
    expect(mergeResult.exitCode).toBe(0);

    // Verify the file exists on main
    expect(await Bun.file(`${leaderDir}/api.ts`).exists()).toBe(true);

    // Verify merge commit
    const log = await gitExec(leaderDir, ["log", "--oneline"]);
    expect(log.stdout).toContain("Merge agent/alice");
  });
});

describe("pullOriginMain", () => {
  test("agent pulls merged changes from leader", async () => {
    // Setup leader
    const leaderDir = `${tmpDir}/bob`;
    await initRepo(leaderDir);
    await createGitignore(leaderDir);
    await commitAll(leaderDir, "Initial commit");

    // Clone two agents
    const aliceDir = `${tmpDir}/alice`;
    await cloneForAgent(leaderDir, aliceDir, "alice");

    const charlieDir = `${tmpDir}/charlie`;
    await cloneForAgent(leaderDir, charlieDir, "charlie");

    // Alice does work and gets merged
    await Bun.write(`${aliceDir}/shared.ts`, "export const X = 1;");
    await commitAll(aliceDir, "Add shared module");
    await addRemoteAndFetch(leaderDir, "alice", aliceDir);
    await mergeAgentBranch(leaderDir, "alice");

    // Charlie pulls the update
    const pullResult = await pullOriginMain(charlieDir);
    expect(pullResult.exitCode).toBe(0);

    // Charlie should now have Alice's file
    expect(await Bun.file(`${charlieDir}/shared.ts`).exists()).toBe(true);
    const content = await Bun.file(`${charlieDir}/shared.ts`).text();
    expect(content).toContain("export const X = 1");
  });
});

describe("gitExec", () => {
  test("returns stdout, stderr, and exitCode", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);
    await createGitignore(repoDir);
    await commitAll(repoDir, "Initial");

    const result = await gitExec(repoDir, ["status"]);
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });

  test("returns non-zero exitCode for invalid commands", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);

    const result = await gitExec(repoDir, ["checkout", "nonexistent-branch"]);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("state/ and logs/ are gitignored", () => {
  test("state files are not tracked", async () => {
    const repoDir = `${tmpDir}/repo`;
    await initRepo(repoDir);
    await createGitignore(repoDir);
    await commitAll(repoDir, "Initial commit");

    // Create state and logs files
    await Bun.$`mkdir -p ${repoDir}/state`.quiet();
    await Bun.write(`${repoDir}/state/iteration-1-plan.json`, "{}");
    await Bun.$`mkdir -p ${repoDir}/logs`.quiet();
    await Bun.write(`${repoDir}/logs/agent.log`, "log line");

    const status = await gitExec(repoDir, ["status", "--porcelain"]);
    expect(status.stdout).not.toContain("state/");
    expect(status.stdout).not.toContain("logs/");
  });
});
