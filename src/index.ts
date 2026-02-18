import type {
  AgentConfig,
  CLIOptions,
  SessionState,
  AgentSessionEntry,
  QueueMessage,
} from "./types.ts";
import { MessageQueue } from "./message-queue.ts";
import {
  initRepo,
  createGitignore,
  commitAll,
} from "./git-manager.ts";
import {
  ensureDirectories,
  readSessionState,
  writeSessionState,
  getLastCompletedStep,
} from "./state-manager.ts";
import {
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
} from "./logger.ts";

// ─── CLI Argument Parsing ────────────────────────────────────────

export function parseCLIArgs(argv: string[]): CLIOptions {
  // Find the goal (first non-option argument after the script name)
  // argv is typically: ["bun", "src/index.ts", ...options, "goal"]
  const args = argv.slice(2); // skip bun and script

  let workers = parseInt(process.env.SEALTEAM_MAX_AGENTS ?? "6", 10);
  let budget = parseInt(process.env.SEALTEAM_DEFAULT_BUDGET ?? "100000", 10);
  let maxIterations = parseInt(process.env.SEALTEAM_DEFAULT_MAX_ITERATIONS ?? "50", 10);
  let workspace = process.env.SEALTEAM_WORKSPACE ?? "./workspace";
  let valkeyUrl = process.env.VALKEY_URL ?? "valkey://localhost:6379";
  let leaderModel = process.env.SEALTEAM_LEADER_MODEL ?? "claude-opus-4-6";
  let teamModel = process.env.SEALTEAM_TEAM_MODEL ?? "claude-sonnet-4-6";
  let resumeFrom: string | undefined;
  let goal = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--workers" && args[i + 1]) {
      workers = parseInt(args[++i]!, 10);
    } else if (arg === "--budget" && args[i + 1]) {
      budget = parseInt(args[++i]!, 10);
    } else if (arg === "--max-iterations" && args[i + 1]) {
      maxIterations = parseInt(args[++i]!, 10);
    } else if (arg === "--workspace" && args[i + 1]) {
      workspace = args[++i]!;
    } else if (arg === "--valkey-url" && args[i + 1]) {
      valkeyUrl = args[++i]!;
    } else if (arg === "--leader-model" && args[i + 1]) {
      leaderModel = args[++i]!;
    } else if (arg === "--team-model" && args[i + 1]) {
      teamModel = args[++i]!;
    } else if (arg === "--resume-from" && args[i + 1]) {
      resumeFrom = args[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("--")) {
      goal = arg;
    }
  }

  // Clamp workers to valid range
  workers = Math.max(1, Math.min(12, workers));

  return {
    goal,
    workers,
    budget,
    maxIterations,
    workspace,
    valkeyUrl,
    leaderModel,
    teamModel,
    resumeFrom,
  };
}

export function validateOptions(options: CLIOptions): string | null {
  if (!options.goal && !options.resumeFrom) {
    return "Error: No goal provided. Usage: bun run sealteam \"<goal>\"";
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return "Error: ANTHROPIC_API_KEY environment variable is required.";
  }
  if (options.budget <= 0) {
    return "Error: --budget must be a positive number.";
  }
  if (options.maxIterations <= 0) {
    return "Error: --max-iterations must be a positive number.";
  }
  return null;
}

function printUsage(): void {
  console.log(`
SealTeam - AI Agent Team CLI

Usage:
  bun run sealteam [options] "<goal>"

Options:
  --workers <n>          Maximum number of worker agents (default: 6, max: 12)
  --budget <n>           Default token budget per agent (default: 100000)
  --max-iterations <n>   Default max iterations per agent (default: 50)
  --workspace <path>     Output workspace directory (default: ./workspace)
  --valkey-url <url>     Valkey connection URL (default: valkey://localhost:6379)
  --leader-model <model> Model for team leader (default: claude-opus-4-6)
  --team-model <model>   Model for teammates (default: claude-sonnet-4-6)
  --resume-from <path>   Resume from a previous session workspace
  -h, --help             Show this help message

Environment Variables:
  ANTHROPIC_API_KEY              Required. Claude API key.
  VALKEY_URL                     Valkey connection URL
  SEALTEAM_WORKSPACE             Output workspace directory
  SEALTEAM_MAX_AGENTS            Maximum worker agents
  SEALTEAM_DEFAULT_BUDGET        Default token budget per agent
  SEALTEAM_DEFAULT_MAX_ITERATIONS Default max iterations per agent
  SEALTEAM_LEADER_MODEL          Model for team leader
  SEALTEAM_TEAM_MODEL            Model for teammates
`);
}

// ─── Main Process ────────────────────────────────────────────────

interface AgentProcess {
  proc: ReturnType<typeof Bun.spawn>;
  config: AgentConfig;
}

export async function main(options: CLIOptions): Promise<void> {
  const { workspace, valkeyUrl } = options;

  logMainStart(options.goal, workspace, options.workers);

  // 1. Check for session recovery
  if (options.resumeFrom) {
    logMainMessage("main", "recovery", `Resuming from: ${options.resumeFrom}`);
    await runRecovery(options);
    return;
  }

  // 2. Create workspace directories
  await Bun.$`mkdir -p ${workspace}/logs`.quiet();

  // 3. Init Valkey and flush stale queues from previous runs
  const mq = new MessageQueue(valkeyUrl);
  const flushedCount = await mq.flushAll();
  if (flushedCount > 0) {
    logMainMessage("main", "cleanup", `flushed ${flushedCount} stale queue(s) from previous run`);
  }

  // 4. Init git repo for leader (bob)
  const bobDir = `${workspace}/bob`;
  await initRepo(bobDir);
  await createGitignore(bobDir);
  await commitAll(bobDir, "Initial commit");

  // 5. Build leader config
  const bobConfig: AgentConfig = {
    name: "bob",
    role: "Team Leader — break down the user's goal into requirements, plan the team, spawn and manage agents, review their work, and coordinate completion.",
    purpose: `Achieve the following goal by creating and managing a team of AI agents: ${options.goal}`,
    tools: ["bash", "read-file", "write-file", "web-search", "web-fetch", "spawn-agent", "send-message", "git", "create-tool"],
    model: options.leaderModel,
    tokenBudget: options.budget * 2, // Leader gets 2x budget
    maxIterations: options.maxIterations,
    maxToolTurns: 75, // Leader needs more tool turns for merges
    workspacePath: workspace,
    valkeyUrl,
  };

  // 6. Write initial session state
  const session: SessionState = {
    goal: options.goal,
    startTime: Date.now(),
    workspace,
    valkeyUrl,
    agents: [],
    status: "running",
  };
  await writeSessionState(workspace, session);

  // 7. Spawn team leader
  logSpawnLeader();
  const bobProc = spawnAgent(bobConfig, options);

  // Add Bob to session
  session.agents.push({
    config: bobConfig,
    pid: bobProc.pid,
    status: "running",
    startTime: Date.now(),
  });
  await writeSessionState(workspace, session);

  // 8. Send goal to Bob's queue
  await mq.send({
    id: crypto.randomUUID(),
    from: "main",
    to: "bob",
    type: "task",
    content: options.goal,
    timestamp: Date.now(),
  });

  // 9. Set up graceful shutdown
  const agentProcesses: AgentProcess[] = [{ proc: bobProc, config: bobConfig }];
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logShutdown(signal);

    // Collect all PIDs to kill: tracked processes + any from session.json
    const pidsToKill = new Set<number>();

    // 1. Kill all tracked agent processes immediately with SIGTERM
    for (const ap of agentProcesses) {
      try {
        pidsToKill.add(ap.proc.pid);
        ap.proc.kill("SIGTERM");
      } catch {
        // Already dead
      }
    }

    // 2. Read session.json for leader-spawned agents we might not be tracking
    const currentSession = await readSessionState(workspace);
    if (currentSession) {
      for (const agent of currentSession.agents) {
        if (agent.status === "running" && !pidsToKill.has(agent.pid)) {
          try {
            process.kill(agent.pid, "SIGTERM");
            pidsToKill.add(agent.pid);
          } catch {
            // Already dead
          }
        }
      }
    }

    logMainMessage("main", "shutdown", `sent SIGTERM to ${pidsToKill.size} processes`);

    // 3. Wait up to 5s for graceful exit, then SIGKILL everything
    const timeout = setTimeout(() => {
      logMainMessage("main", "shutdown", "grace period expired, sending SIGKILL");
      for (const pid of pidsToKill) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead
        }
      }
    }, 5000);

    // Wait for tracked processes to exit
    await Promise.allSettled(
      agentProcesses.map((ap) => ap.proc.exited),
    );
    clearTimeout(timeout);

    // Final SIGKILL sweep for any survivors (leader-spawned agents)
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }

    // Update session state
    const finalSession = await readSessionState(workspace);
    if (finalSession) {
      finalSession.status = "failed";
      for (const agent of finalSession.agents) {
        if (agent.status === "running") {
          agent.status = "cancelled";
          agent.endTime = Date.now();
        }
      }
      await writeSessionState(workspace, finalSession);
    }

    mq.close();
    logShutdownComplete();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 10. Monitor loop
  logMonitoring();
  await monitorLoop(mq, workspace, options, agentProcesses);

  // 11. Print summary
  const finalSession = await readSessionState(workspace);
  if (finalSession) {
    printSummaryReport(finalSession);
  }

  // 12. Cleanup
  mq.close();
}

// ─── Agent Spawning ──────────────────────────────────────────────

function spawnAgent(
  config: AgentConfig,
  options: CLIOptions,
): ReturnType<typeof Bun.spawn> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    AGENT_CONFIG: JSON.stringify(config),
    SEALTEAM_TEAM_MODEL: options.teamModel,
    SEALTEAM_DEFAULT_BUDGET: String(options.budget),
    SEALTEAM_DEFAULT_MAX_ITERATIONS: String(options.maxIterations),
    SEALTEAM_MAX_AGENTS: String(options.workers),
  };

  return Bun.spawn(["bun", "src/life-loop.ts"], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
}

// ─── Monitor Loop ────────────────────────────────────────────────

async function monitorLoop(
  mq: MessageQueue,
  workspace: string,
  options: CLIOptions,
  agentProcesses: AgentProcess[],
): Promise<void> {
  while (true) {
    // Check for messages on the main queue
    const msg = await mq.receive("main", 5);

    if (msg) {
      if (msg.type === "all-complete") {
        logAllComplete(msg.content);

        // Update session state
        const session = await readSessionState(workspace);
        if (session) {
          session.status = "completed";
          await writeSessionState(workspace, session);
        }

        // Wait for all processes to exit
        await Promise.allSettled(
          agentProcesses.map((ap) => ap.proc.exited),
        );
        return;
      }

      // Log other messages from agents
      logMainMessage(msg.from, msg.type, msg.content);
    }

    // Check for crashed agent processes and re-spawn if needed
    for (let i = 0; i < agentProcesses.length; i++) {
      const ap = agentProcesses[i]!;
      const exitCode = ap.proc.exitCode;

      if (exitCode !== null && exitCode !== 0) {
        logAgentCrash(ap.config.name, exitCode);

        // Check if the agent completed
        const agentDir = `${workspace}/${ap.config.name}`;
        const lastStep = await getLastCompletedStep(agentDir);

        if (lastStep?.step === "reflect") {
          // Check if the last reflect was a "complete" decision
          const { readIterationState } = await import("./state-manager.ts");
          const reflectState = await readIterationState(agentDir, lastStep.iteration, "reflect");
          const output = reflectState?.output as Record<string, unknown> | null;
          if (output?.decision === "complete") {
            logMainMessage(ap.config.name, "info", "completed before crash, not re-spawning");
            await updateAgentStatus(workspace, ap.config.name, "completed");
            continue;
          }
        }

        // Re-spawn with resume
        logAgentRespawn(ap.config.name, lastStep ? `${lastStep.iteration}-${lastStep.step}` : undefined);
        const resumePoint = lastStep
          ? `${lastStep.iteration}-${lastStep.step}`
          : undefined;

        const newConfig = { ...ap.config };
        const newProc = spawnAgent(newConfig, options);

        if (resumePoint) {
          // Set resume env for the respawned process
          // Note: RESUME_FROM is read by life-loop.ts
          const env = {
            ...process.env as Record<string, string>,
            AGENT_CONFIG: JSON.stringify(newConfig),
            RESUME_FROM: resumePoint,
            SEALTEAM_TEAM_MODEL: options.teamModel,
            SEALTEAM_DEFAULT_BUDGET: String(options.budget),
            SEALTEAM_DEFAULT_MAX_ITERATIONS: String(options.maxIterations),
            SEALTEAM_MAX_AGENTS: String(options.workers),
          };

          // Kill the process we just started and restart with resume env
          newProc.kill();
          const resumeProc = Bun.spawn(["bun", "src/life-loop.ts"], {
            env,
            stdout: "inherit",
            stderr: "inherit",
          });

          agentProcesses[i] = { proc: resumeProc, config: newConfig };

          // Update session
          await updateAgentPid(workspace, ap.config.name, resumeProc.pid);
        } else {
          agentProcesses[i] = { proc: newProc, config: newConfig };
          await updateAgentPid(workspace, ap.config.name, newProc.pid);
        }
      } else if (exitCode === 0) {
        // Agent exited cleanly
        await updateAgentStatus(workspace, ap.config.name, "completed");

        // Fallback: if Bob exits cleanly, ensure session is marked completed
        if (ap.config.name === "bob") {
          const session = await readSessionState(workspace);
          if (session && session.status === "running") {
            logMainMessage("main", "info", "Bob exited cleanly — marking session completed (fallback)");
            session.status = "completed";
            await writeSessionState(workspace, session);
          }
        }
      }
    }

    // Remove completed agents from monitoring
    for (let i = agentProcesses.length - 1; i >= 0; i--) {
      if (agentProcesses[i]!.proc.exitCode === 0) {
        agentProcesses.splice(i, 1);
      }
    }

    // Check if all agents have exited (no more work to do)
    if (agentProcesses.length === 0) {
      logAllComplete("All agents have exited.");
      return;
    }

    // Periodically check for new agent processes spawned by the leader
    await syncAgentProcesses(workspace, options, agentProcesses);
  }
}

// ─── Session Recovery ────────────────────────────────────────────

async function runRecovery(options: CLIOptions): Promise<void> {
  const workspace = options.resumeFrom ?? options.workspace;
  const session = await readSessionState(workspace);

  if (!session) {
    console.error(`No session.json found in ${workspace}`);
    process.exit(1);
  }

  logMainStart(session.goal, workspace, session.agents.length);

  const mq = new MessageQueue(session.valkeyUrl);
  const agentProcesses: AgentProcess[] = [];

  for (const agentEntry of session.agents) {
    if (agentEntry.status === "completed" || agentEntry.status === "cancelled") {
      logMainMessage(agentEntry.config.name, "info", `${agentEntry.status} (skipping)`);
      continue;
    }

    // Check if process is still alive
    const isAlive = isProcessAlive(agentEntry.pid);
    if (isAlive) {
      logMainMessage(agentEntry.config.name, "info", `still running (PID ${agentEntry.pid})`);
      // We can't get a handle on an existing process, so we'll skip monitoring it
      // The agent should still be working and will send messages when done
      continue;
    }

    // Process died — re-spawn with resume
    const agentDir = `${workspace}/${agentEntry.config.name}`;
    const lastStep = await getLastCompletedStep(agentDir);

    if (lastStep) {
      const { readIterationState } = await import("./state-manager.ts");
      const reflectState = await readIterationState(agentDir, lastStep.iteration, "reflect");
      const output = reflectState?.output as Record<string, unknown> | null;
      if (lastStep.step === "reflect" && output?.decision === "complete") {
        logMainMessage(agentEntry.config.name, "info", "completed (not re-spawning)");
        agentEntry.status = "completed";
        agentEntry.endTime = Date.now();
        continue;
      }
    }

    const resumePoint = lastStep
      ? `${lastStep.iteration}-${lastStep.step}`
      : undefined;

    logAgentRespawn(agentEntry.config.name, resumePoint);

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      AGENT_CONFIG: JSON.stringify(agentEntry.config),
      SEALTEAM_TEAM_MODEL: options.teamModel,
      SEALTEAM_DEFAULT_BUDGET: String(options.budget),
      SEALTEAM_DEFAULT_MAX_ITERATIONS: String(options.maxIterations),
      SEALTEAM_MAX_AGENTS: String(options.workers),
      ...(resumePoint ? { RESUME_FROM: resumePoint } : {}),
    };

    const proc = Bun.spawn(["bun", "src/life-loop.ts"], {
      env,
      stdout: "inherit",
      stderr: "inherit",
    });

    agentEntry.pid = proc.pid;
    agentEntry.status = "running";
    agentProcesses.push({ proc, config: agentEntry.config });
  }

  await writeSessionState(workspace, session);

  if (agentProcesses.length === 0) {
    logAllComplete("No agents to recover.");
    mq.close();
    return;
  }

  // Set up shutdown handler
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logShutdown("SIGNAL");

    // Kill all tracked processes
    const pidsToKill = new Set<number>();
    for (const ap of agentProcesses) {
      try {
        pidsToKill.add(ap.proc.pid);
        ap.proc.kill("SIGTERM");
      } catch { /* already dead */ }
    }

    // Also kill any from session.json
    const shutdownSession = await readSessionState(workspace);
    if (shutdownSession) {
      for (const agent of shutdownSession.agents) {
        if (agent.status === "running" && !pidsToKill.has(agent.pid)) {
          try {
            process.kill(agent.pid, "SIGTERM");
            pidsToKill.add(agent.pid);
          } catch { /* already dead */ }
        }
      }
    }

    // Force kill after 5s grace period
    setTimeout(() => {
      for (const pid of pidsToKill) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
      process.exit(1);
    }, 5000);
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  // Resume monitoring
  await monitorLoop(mq, workspace, options, agentProcesses);
  const recoveredSession = await readSessionState(workspace);
  if (recoveredSession) {
    printSummaryReport(recoveredSession);
  }
  mq.close();
}

// ─── Helpers ─────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function updateAgentStatus(
  workspace: string,
  agentName: string,
  status: "completed" | "failed" | "cancelled",
): Promise<void> {
  const session = await readSessionState(workspace);
  if (!session) return;

  const agent = session.agents.find((a) => a.config.name === agentName);
  if (agent) {
    agent.status = status;
    agent.endTime = Date.now();
    await writeSessionState(workspace, session);
  }
}

async function updateAgentPid(
  workspace: string,
  agentName: string,
  newPid: number,
): Promise<void> {
  const session = await readSessionState(workspace);
  if (!session) return;

  const agent = session.agents.find((a) => a.config.name === agentName);
  if (agent) {
    agent.pid = newPid;
    agent.status = "running";
    await writeSessionState(workspace, session);
  }
}

/**
 * Sync agent process list with session.json to pick up agents
 * spawned by the leader (via spawn-agent tool).
 */
async function syncAgentProcesses(
  workspace: string,
  options: CLIOptions,
  agentProcesses: AgentProcess[],
): Promise<void> {
  const session = await readSessionState(workspace);
  if (!session) return;

  const trackedNames = new Set(agentProcesses.map((ap) => ap.config.name));

  for (const agentEntry of session.agents) {
    if (trackedNames.has(agentEntry.config.name)) continue;
    if (agentEntry.status !== "running") continue;

    // This agent was spawned by the leader but we're not tracking it yet
    // Check if it's still alive
    if (isProcessAlive(agentEntry.pid)) {
      // We can't get a Bun.spawn handle for an already-running process,
      // but we can create a proxy that watches for process exit
      logMainMessage(agentEntry.config.name, "tracking", `new agent (PID ${agentEntry.pid})`);

      // Create a polling watcher since we can't get the original handle
      const watcherProc = Bun.spawn(["sh", "-c", `while kill -0 ${agentEntry.pid} 2>/dev/null; do sleep 2; done; exit 0`], {
        stdout: "ignore",
        stderr: "ignore",
      });

      agentProcesses.push({
        proc: watcherProc,
        config: agentEntry.config,
      });
    } else {
      // Process already dead, mark as completed or failed
      const agentDir = `${workspace}/${agentEntry.config.name}`;
      const lastStep = await getLastCompletedStep(agentDir);
      if (lastStep?.step === "reflect") {
        await updateAgentStatus(workspace, agentEntry.config.name, "completed");
      } else {
        await updateAgentStatus(workspace, agentEntry.config.name, "failed");
      }
    }
  }
}

// ─── Entry Point ─────────────────────────────────────────────────

if (import.meta.main) {
  const options = parseCLIArgs(process.argv);
  const error = validateOptions(options);

  if (error) {
    console.error(error);
    printUsage();
    process.exit(1);
  }

  main(options).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
