import type { AgentConfig, SessionState, TokenUsage } from "./types.ts";

// ─── ANSI Color Codes ────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const GRAY = "\x1b[90m";

// ─── Agent Color Assignment ──────────────────────────────────────

const AGENT_COLORS = [CYAN, MAGENTA, YELLOW, GREEN, BLUE, WHITE];
const agentColorMap = new Map<string, string>();
let nextColorIndex = 0;

function getAgentColor(agentName: string): string {
  if (agentName === "bob") return BOLD + CYAN;
  let color = agentColorMap.get(agentName);
  if (!color) {
    color = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length]!;
    agentColorMap.set(agentName, color);
    nextColorIndex++;
  }
  return color;
}

// ─── Timestamp ───────────────────────────────────────────────────

function timestamp(): string {
  return `${GRAY}${new Date().toISOString()}${RESET}`;
}

function agentTag(name: string): string {
  const color = getAgentColor(name);
  return `${color}[${name}]${RESET}`;
}

// ─── Public Logging Functions ────────────────────────────────────

export function logAgentStart(config: AgentConfig): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${GREEN}Starting${RESET} life loop (model: ${DIM}${config.model}${RESET})`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logIteration(
  config: AgentConfig,
  iteration: number,
  path: "standard" | "fast",
): void {
  const pathLabel = path === "fast"
    ? `${YELLOW}fast path${RESET}`
    : `${BLUE}standard path${RESET}`;
  const line = `${timestamp()} ${agentTag(config.name)} Iteration ${BOLD}${iteration}${RESET} (${pathLabel})`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logStepComplete(
  config: AgentConfig,
  step: string,
  tokens: TokenUsage,
): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${DIM}${step}${RESET} complete (${tokens.input}+${tokens.output} tokens)`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logToolCall(config: AgentConfig, toolName: string): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${DIM}tool:${RESET} ${toolName}`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logComplete(config: AgentConfig, summary: string): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${GREEN}${BOLD}Complete${RESET} — ${summary.slice(0, 200)}`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logError(config: AgentConfig, message: string): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${RED}${BOLD}Error${RESET}: ${message}`;
  console.error(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logRecovery(config: AgentConfig, attempt: number, max: number): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${YELLOW}Self-recovery${RESET} attempt ${attempt}/${max}`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logEscalation(config: AgentConfig, details: string): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${RED}Escalating${RESET} to leader: ${details.slice(0, 200)}`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logCancel(config: AgentConfig, reason: string): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${YELLOW}Cancelled${RESET}: ${reason}`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logIdle(config: AgentConfig, cycles: number): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${DIM}Idle${RESET} (${cycles} cycles)`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logBudgetExhausted(config: AgentConfig, used: number, budget: number): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${YELLOW}Budget exhausted${RESET} (${used}/${budget} tokens)`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logMaxIterations(config: AgentConfig, max: number): void {
  const line = `${timestamp()} ${agentTag(config.name)} ${YELLOW}Max iterations${RESET} reached (${max})`;
  console.log(line);
  appendToFile(config.workspacePath, config.name, line);
}

export function logRetry(context: string, attempt: number, maxAttempts: number, delayMs: number): void {
  console.log(`${timestamp()} ${YELLOW}Retry${RESET} ${context} (attempt ${attempt}/${maxAttempts}, waiting ${delayMs}ms)`);
}

// ─── Main Process Logging ────────────────────────────────────────

export function logMainStart(goal: string, workspace: string, workers: number): void {
  console.log(`\n${BOLD}${CYAN}🦭 SealTeam${RESET} starting...\n`);
  console.log(`  ${BOLD}Goal:${RESET}      ${goal}`);
  console.log(`  ${BOLD}Workspace:${RESET} ${workspace}`);
  console.log(`  ${BOLD}Workers:${RESET}   ${workers}`);
  console.log("");
}

export function logSpawnLeader(): void {
  console.log(`${timestamp()} ${BOLD}${GREEN}Spawning${RESET} team leader ${BOLD}${CYAN}bob${RESET}...`);
}

export function logMonitoring(): void {
  console.log(`${timestamp()} ${DIM}Monitoring for completion...${RESET}\n`);
}

export function logAllComplete(content: string): void {
  console.log(`\n${timestamp()} ${BOLD}${GREEN}All work complete!${RESET} ${content}`);
}

export function logMainMessage(from: string, type: string, content: string): void {
  console.log(`${timestamp()} ${DIM}[main]${RESET} Message from ${BOLD}${from}${RESET}: (${type}) ${content.slice(0, 200)}`);
}

export function logAgentCrash(name: string, exitCode: number): void {
  console.log(`${timestamp()} ${RED}${BOLD}Agent crashed:${RESET} ${name} (exit code: ${exitCode})`);
}

export function logAgentRespawn(name: string, resumePoint?: string): void {
  const suffix = resumePoint ? ` from ${resumePoint}` : "";
  console.log(`${timestamp()} ${YELLOW}Re-spawning${RESET} ${name}${suffix}...`);
}

export function logShutdown(signal: string): void {
  console.log(`\n${timestamp()} ${YELLOW}${BOLD}Received ${signal}${RESET}, shutting down gracefully...`);
}

export function logShutdownComplete(): void {
  console.log(`${timestamp()} ${GREEN}Shutdown complete.${RESET}`);
}

// ─── Summary Report ──────────────────────────────────────────────

export function printSummaryReport(session: SessionState): void {
  const duration = formatDuration(Date.now() - session.startTime);
  const statusColor = session.status === "completed" ? GREEN : session.status === "failed" ? RED : YELLOW;

  console.log("");
  console.log(`${BOLD}${"═".repeat(55)}${RESET}`);
  console.log(`${BOLD}${CYAN}              SealTeam Summary${RESET}`);
  console.log(`${BOLD}${"═".repeat(55)}${RESET}`);
  console.log(`  ${BOLD}Goal:${RESET}     ${session.goal}`);
  console.log(`  ${BOLD}Status:${RESET}   ${statusColor}${BOLD}${session.status}${RESET}`);
  console.log(`  ${BOLD}Duration:${RESET} ${duration}`);
  console.log(`  ${BOLD}Workspace:${RESET} ${session.workspace}`);
  console.log("");

  if (session.agents.length > 0) {
    console.log(`  ${BOLD}Agents:${RESET}`);
    console.log(`  ${"─".repeat(51)}`);

    for (const agent of session.agents) {
      const agentDuration = agent.endTime
        ? formatDuration(agent.endTime - agent.startTime)
        : `${DIM}still running${RESET}`;
      const statusIcon =
        agent.status === "completed" ? `${GREEN}✓${RESET}` :
        agent.status === "failed" ? `${RED}✗${RESET}` :
        agent.status === "cancelled" ? `${YELLOW}⊘${RESET}` : `${DIM}…${RESET}`;
      const roleSnippet = agent.config.role.slice(0, 50);

      console.log(`  ${statusIcon} ${BOLD}${agent.config.name}${RESET} ${DIM}(${roleSnippet})${RESET}`);
      console.log(`    Status: ${agent.status} | Duration: ${agentDuration} | Model: ${DIM}${agent.config.model}${RESET}`);
    }

    console.log("");
  }

  console.log(`  ${BOLD}Work product:${RESET} ${session.workspace}/bob/`);
  console.log(`${BOLD}${"═".repeat(55)}${RESET}`);
}

// ─── Helpers ─────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Strip ANSI escape codes from a string (for plain-text log files).
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function appendToFile(workspacePath: string, agentName: string, line: string): void {
  const logPath = `${workspacePath}/logs/${agentName}.log`;
  const plainLine = stripAnsi(line) + "\n";
  Bun.write(logPath, plainLine).catch(() => {});
}
