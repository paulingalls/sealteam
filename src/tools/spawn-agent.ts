import type {
  ToolDefinition,
  AgentConfig,
  SessionState,
} from "../types.ts";
import {
  readSessionState,
  writeSessionState,
  ensureDirectories,
} from "../state-manager.ts";
import { cloneForAgent } from "../git-manager.ts";

export const definition: ToolDefinition = {
  name: "spawn-agent",
  description:
    "Spawn a new agent subprocess with the given configuration. This creates a clone of the leader's git repo for the agent and starts the agent's life loop. Leader-only tool.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Unique agent name (used for queue addressing and directory name)",
      },
      role: {
        type: "string",
        description:
          'Description of what this agent does (e.g. "backend engineer", "technical writer")',
      },
      purpose: {
        type: "string",
        description:
          "The completion condition — when met, the agent exits its loop",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description:
          "List of tool names this agent is allowed to use",
      },
      model: {
        type: "string",
        description:
          "Claude model to use (default: team model from config)",
      },
      tokenBudget: {
        type: "number",
        description: "Maximum tokens this agent may consume (default: from config)",
      },
      maxIterations: {
        type: "number",
        description: "Maximum loop iterations (default: from config)",
      },
    },
    required: ["name", "role", "purpose", "tools"],
  },
};

export interface SpawnContext {
  workspacePath: string;
  valkeyUrl: string;
  defaultModel: string;
  defaultBudget: number;
  defaultMaxIterations: number;
  maxWorkers: number;
}

/**
 * Create a handler bound to the leader's spawn context.
 */
export function createHandler(ctx: SpawnContext) {
  return async (input: Record<string, unknown>): Promise<string> => {
    const name = input.name as string;
    const role = input.role as string;
    const purpose = input.purpose as string;
    const tools = input.tools as string[];
    const model = (input.model as string) || ctx.defaultModel;
    const tokenBudget = (input.tokenBudget as number) || ctx.defaultBudget;
    const maxIterations =
      (input.maxIterations as number) || ctx.defaultMaxIterations;

    // Check worker limit
    const session = await readSessionState(ctx.workspacePath);
    if (session) {
      const activeAgents = session.agents.filter(
        (a) => a.status === "running" && a.config.name !== "bob",
      );
      if (activeAgents.length >= ctx.maxWorkers) {
        return `Error: Maximum worker limit reached (${ctx.maxWorkers}). Wait for an agent to complete or cancel one.`;
      }
    }

    const agentConfig: AgentConfig = {
      name,
      role,
      purpose,
      tools,
      model,
      tokenBudget,
      maxIterations,
      workspacePath: ctx.workspacePath,
      valkeyUrl: ctx.valkeyUrl,
    };

    // Ensure logs directory exists (agent dir is created by git clone)
    await Bun.$`mkdir -p ${ctx.workspacePath}/logs`.quiet();

    // Clone leader's repo for the agent
    const leaderDir = `${ctx.workspacePath}/bob`;
    const agentDir = `${ctx.workspacePath}/${name}`;
    try {
      await cloneForAgent(leaderDir, agentDir, name);
      // Create state directory inside the clone
      await Bun.$`mkdir -p ${agentDir}/state`.quiet();
    } catch (err) {
      return `Error cloning repo for agent: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Spawn the subprocess
    const proc = Bun.spawn(["bun", "src/life-loop.ts"], {
      env: {
        ...process.env,
        AGENT_CONFIG: JSON.stringify(agentConfig),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Update session state
    const currentSession =
      (await readSessionState(ctx.workspacePath)) ||
      ({
        goal: "",
        startTime: Date.now(),
        workspace: ctx.workspacePath,
        valkeyUrl: ctx.valkeyUrl,
        agents: [],
        status: "running",
      } satisfies SessionState);

    currentSession.agents.push({
      config: agentConfig,
      pid: proc.pid,
      status: "running",
      startTime: Date.now(),
    });

    await writeSessionState(ctx.workspacePath, currentSession);

    return `Agent "${name}" spawned (PID: ${proc.pid}, role: ${role}, model: ${model})`;
  };
}

/**
 * Default handler — requires bound context.
 */
export async function handler(
  _input: Record<string, unknown>,
): Promise<string> {
  throw new Error(
    "spawn-agent requires a bound handler created via createHandler(). " +
      "The tool registry should set this up with the leader's spawn context.",
  );
}
