// ─── Message Queue ───────────────────────────────────────────────

export type MessageType =
  | "task"
  | "status"
  | "review"
  | "complete"
  | "error"
  | "cancel"
  | "all-complete";

export interface QueueMessage {
  id: string;
  from: string;
  to: string; // agent name, "shared", or "main"
  type: MessageType;
  content: string;
  timestamp: number;
}

// ─── Agent Configuration ─────────────────────────────────────────

export interface AgentConfig {
  name: string;
  role: string;
  purpose: string;
  tools: string[];
  model: string;
  tokenBudget: number;
  maxIterations: number;
  workspacePath: string;
  valkeyUrl: string;
}

// ─── Iteration State ─────────────────────────────────────────────

export type StepType = "plan" | "execute" | "plan-execute" | "reflect";

export interface TokenUsage {
  input: number;
  output: number;
}

export interface IterationState {
  iteration: number;
  step: StepType;
  timestamp: number;
  input: unknown;
  output: unknown;
  tokensUsed: TokenUsage;
  complexity?: "simple" | "complex";
}

// ─── Reflect Output ──────────────────────────────────────────────

export type ReflectDecisionType = "continue" | "complete" | "error";

export interface ReflectDecision {
  decision: ReflectDecisionType;
  summary: IterationSummary;
  nextMessage?: string;
  errorDetails?: string;
  selfRecoveryAttempt?: number;
}

export interface IterationSummary {
  iteration: number;
  plan: string;
  outcome: string;
  filesChanged: string[];
  decisions: string[];
}

// ─── Session State (crash recovery) ──────────────────────────────

export type SessionStatus = "running" | "completed" | "failed";
export type AgentStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentSessionEntry {
  config: AgentConfig;
  pid: number;
  status: AgentStatus;
  startTime: number;
  endTime?: number;
}

export interface SessionState {
  goal: string;
  startTime: number;
  workspace: string;
  valkeyUrl: string;
  agents: AgentSessionEntry[];
  status: SessionStatus;
}

// ─── Tool System ─────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolModule {
  definition: ToolDefinition;
  handler: (input: Record<string, unknown>) => Promise<string>;
}

export type ToolStatus = "pending" | "active" | "disabled";

export interface ToolRegistryEntry {
  name: string;
  path: string;
  status: ToolStatus;
  validatedAt?: number;
  error?: string;
}

// ─── CLI Options ─────────────────────────────────────────────────

export interface CLIOptions {
  goal: string;
  workers: number;
  budget: number;
  maxIterations: number;
  workspace: string;
  valkeyUrl: string;
  leaderModel: string;
  teamModel: string;
  resumeFrom?: string;
}
