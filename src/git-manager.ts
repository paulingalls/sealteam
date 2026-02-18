export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run an arbitrary git command in a working directory.
 */
export async function gitExec(
  workDir: string,
  args: string[],
): Promise<GitResult> {
  const result = await Bun.$`git -C ${workDir} ${args}`.nothrow().quiet();
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

/**
 * Initialize a new git repo.
 */
export async function initRepo(workDir: string): Promise<void> {
  await Bun.$`mkdir -p ${workDir}`.quiet();
  await Bun.$`git init ${workDir}`.quiet();
  // Set user info for commits within this repo
  await Bun.$`git -C ${workDir} config user.email sealteam@local`.quiet();
  await Bun.$`git -C ${workDir} config user.name SealTeam`.quiet();
}

/**
 * Create a .gitignore that excludes state/ and logs/.
 */
export async function createGitignore(workDir: string): Promise<void> {
  const content = `state/\nlogs/\n`;
  await Bun.write(`${workDir}/.gitignore`, content);
}

/**
 * Stage all changes and commit.
 * Returns the GitResult — check exitCode for success.
 */
export async function commitAll(
  workDir: string,
  message: string,
): Promise<GitResult> {
  await gitExec(workDir, ["add", "-A"]);
  return gitExec(workDir, ["commit", "-m", message, "--allow-empty"]);
}

/**
 * Clone the leader's repo for a new agent and checkout a branch.
 */
export async function cloneForAgent(
  leaderDir: string,
  agentDir: string,
  agentName: string,
): Promise<void> {
  await Bun.$`git clone ${leaderDir} ${agentDir}`.quiet();
  // Inherit user config in the clone
  await Bun.$`git -C ${agentDir} config user.email sealteam@local`.quiet();
  await Bun.$`git -C ${agentDir} config user.name SealTeam`.quiet();
  await Bun.$`git -C ${agentDir} checkout -b agent/${agentName}`.quiet();
}

/**
 * Create and checkout a new branch.
 */
export async function checkoutBranch(
  workDir: string,
  branchName: string,
): Promise<GitResult> {
  return gitExec(workDir, ["checkout", "-b", branchName]);
}

/**
 * Add an agent's clone as a remote and fetch its branch (for PR review).
 * Ignores "remote already exists" errors.
 */
export async function addRemoteAndFetch(
  leaderDir: string,
  agentName: string,
  agentDir: string,
): Promise<void> {
  // Add remote (ignore error if already exists)
  await gitExec(leaderDir, ["remote", "add", agentName, `../${agentName}/`]);
  // Use absolute path for fetch
  await gitExec(leaderDir, ["remote", "set-url", agentName, agentDir]);
  await gitExec(leaderDir, ["fetch", agentName, `agent/${agentName}`]);
}

/**
 * Get diff between main and an agent's branch.
 */
export async function getDiff(
  leaderDir: string,
  agentName: string,
): Promise<string> {
  const result = await gitExec(leaderDir, [
    "diff",
    `main..${agentName}/agent/${agentName}`,
  ]);
  return result.stdout;
}

/**
 * Merge an agent's branch into main (no-ff).
 */
export async function mergeAgentBranch(
  leaderDir: string,
  agentName: string,
): Promise<GitResult> {
  return gitExec(leaderDir, [
    "merge",
    `${agentName}/agent/${agentName}`,
    "--no-ff",
    "-m",
    `Merge agent/${agentName}`,
  ]);
}

/**
 * Pull latest main from origin and merge into current branch.
 */
export async function pullOriginMain(workDir: string): Promise<GitResult> {
  return gitExec(workDir, ["pull", "origin", "main"]);
}
