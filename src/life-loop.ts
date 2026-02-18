import type {
  AgentConfig,
  QueueMessage,
  IterationState,
  ReflectDecision,
  StepType,
  TokenUsage,
} from "./types.ts";
import {
  ClaudeClient,
  getTextContent,
  getToolUseBlocks,
} from "./claude-client.ts";
import type {
  MessageParam,
  ToolUnion,
  ToolUseBlock,
  ContentBlock,
} from "./claude-client.ts";
import { MessageQueue } from "./message-queue.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { ContextManager } from "./context-manager.ts";
import {
  writeIterationState,
  readIterationState,
  getLastCompletedStep,
} from "./state-manager.ts";
import {
  planPrompt,
  executePrompt,
  planExecutePrompt,
  reflectPrompt,
  leaderContextPrompt,
} from "./prompts.ts";
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
  logDebug,
  logMessageReceived,
  logApiCall,
  logApiResult,
  logToolResult,
  logReflectDecision,
  logContextAssembly,
} from "./logger.ts";

const MAX_IDLE_CYCLES = 30;
const MAX_SELF_RECOVERY = 3;
const MAX_TOOL_TURNS = 25;

export interface LifeLoopDeps {
  claudeClient: ClaudeClient;
  messageQueue: MessageQueue;
  toolRegistry: ToolRegistry;
  contextManager: ContextManager;
}

/**
 * Run the life loop for an agent. This is the core execution loop
 * shared by all agents (leader and teammates alike).
 */
export async function runLifeLoop(
  config: AgentConfig,
  deps: LifeLoopDeps,
): Promise<void> {
  const { claudeClient, messageQueue, toolRegistry, contextManager } = deps;
  const agentDir = `${config.workspacePath}/${config.name}`;

  // Ensure state directory exists
  await Bun.$`mkdir -p ${agentDir}/state`.quiet();

  let iteration = 1;
  let idleCycles = 0;
  let selfRecoveryAttempts = 0;
  let lastComplexity: "simple" | "complex" = "complex"; // start with standard path
  const allStates: IterationState[] = [];

  // Check for crash recovery
  const resumeFrom = process.env.RESUME_FROM;
  if (resumeFrom) {
    const recovered = await recoverState(agentDir, resumeFrom, allStates);
    iteration = recovered.iteration;
    lastComplexity = recovered.lastComplexity;
  }

  logAgentStart(config);

  while (iteration <= config.maxIterations) {
    // Check token budget
    const usage = claudeClient.getTokenUsage();
    if (usage.total >= config.tokenBudget) {
      logBudgetExhausted(config, usage.total, config.tokenBudget);
      break;
    }

    // 1. Check for messages
    const message = await messageQueue.receive(config.name, 5);

    if (message) {
      idleCycles = 0;
      logMessageReceived(config, message);

      // Handle cancel
      if (message.type === "cancel") {
        logCancel(config, message.content);
        await handleCancellation(config, message, messageQueue, allStates, iteration, agentDir);
        return;
      }
    } else {
      // No message received
      idleCycles++;

      // Check for cancel via non-blocking pop
      const cancelCheck = await messageQueue.receiveNonBlocking(config.name);
      if (cancelCheck?.type === "cancel") {
        logCancel(config, cancelCheck.content);
        await handleCancellation(config, cancelCheck, messageQueue, allStates, iteration, agentDir);
        return;
      }
      // Put it back if it wasn't a cancel
      if (cancelCheck) {
        await messageQueue.send(cancelCheck, config.workspacePath);
      }

      if (idleCycles >= MAX_IDLE_CYCLES) {
        logIdle(config, idleCycles);
        await messageQueue.send({
          id: crypto.randomUUID(),
          from: config.name,
          to: "bob",
          type: "status",
          content: `Agent ${config.name} has been idle for ${idleCycles} cycles. Awaiting direction.`,
          timestamp: Date.now(),
        });
        idleCycles = 0;
      }

      // If no message and no self-queued work, continue waiting
      if (!message) continue;
    }

    // Check compaction before API calls
    const compactionNeeded = contextManager.checkCompactionNeeded();
    if (compactionNeeded === "hard") {
      const compacted = contextManager.compactIterations(allStates, iteration);
      allStates.length = 0;
      allStates.push(...compacted);
    }

    // 2. Determine path
    const useFastPath = lastComplexity === "simple" && iteration > 1;

    // Scan for dynamic tools
    await toolRegistry.scanDynamic(config.workspacePath);

    const currentMessages = message ? [message] : [];
    let iterationTokens: TokenUsage = { input: 0, output: 0 };

    try {
      if (useFastPath) {
        // ── Fast Path: Plan+Execute → Reflect ──
        logIteration(config, iteration, "fast");

        const peResult = await doPlanExecute(
          config, deps, allStates, currentMessages, iteration,
        );
        iterationTokens = addTokens(iterationTokens, peResult.tokensUsed);
        logStepComplete(config, "plan-execute", peResult.tokensUsed);

        await writeIterationState(agentDir, iteration, "plan-execute", {
          iteration,
          step: "plan-execute",
          timestamp: Date.now(),
          input: currentMessages,
          output: peResult.output,
          tokensUsed: peResult.tokensUsed,
          complexity: peResult.complexity,
        });
        allStates.push({
          iteration,
          step: "plan-execute",
          timestamp: Date.now(),
          input: currentMessages,
          output: peResult.output,
          tokensUsed: peResult.tokensUsed,
          complexity: peResult.complexity,
        });

      } else {
        // ── Standard Path: Plan → Execute → Reflect ──
        logIteration(config, iteration, "standard");

        // Plan
        const planResult = await doPlan(
          config, deps, allStates, currentMessages, iteration,
        );
        iterationTokens = addTokens(iterationTokens, planResult.tokensUsed);
        logStepComplete(config, "plan", planResult.tokensUsed);
        logDebug(config, `plan complexity=${planResult.complexity}, plan="${String(planResult.plan).slice(0, 150)}"`);

        const planState: IterationState = {
          iteration,
          step: "plan",
          timestamp: Date.now(),
          input: currentMessages,
          output: planResult.output,
          tokensUsed: planResult.tokensUsed,
          complexity: planResult.complexity,
        };
        await writeIterationState(agentDir, iteration, "plan", planState);
        allStates.push(planState);

        // Execute
        const execResult = await doExecute(
          config, deps, allStates, planResult.plan, iteration,
        );
        iterationTokens = addTokens(iterationTokens, execResult.tokensUsed);
        logStepComplete(config, "execute", execResult.tokensUsed);

        const execState: IterationState = {
          iteration,
          step: "execute",
          timestamp: Date.now(),
          input: planResult.plan,
          output: execResult.output,
          tokensUsed: execResult.tokensUsed,
        };
        await writeIterationState(agentDir, iteration, "execute", execState);
        allStates.push(execState);
      }

      // ── Reflect (both paths) ──
      const reflectResult = await doReflect(
        config, deps, allStates, iteration,
      );
      iterationTokens = addTokens(iterationTokens, reflectResult.tokensUsed);
      logStepComplete(config, "reflect", reflectResult.tokensUsed);
      logReflectDecision(config, reflectResult.decision.decision, reflectResult.decision.summary?.outcome ?? "no summary");

      const reflectState: IterationState = {
        iteration,
        step: "reflect",
        timestamp: Date.now(),
        input: null,
        output: reflectResult.decision,
        tokensUsed: reflectResult.tokensUsed,
      };
      await writeIterationState(agentDir, iteration, "reflect", reflectState);
      allStates.push(reflectState);

      // Update context manager with actual token usage
      contextManager.updateTokenUsage(iterationTokens.input);

      // Act on reflect decision
      lastComplexity = reflectResult.complexity;

      switch (reflectResult.decision.decision) {
        case "continue": {
          selfRecoveryAttempts = 0;
          // Post next-iteration message to own queue
          if (reflectResult.decision.nextMessage) {
            await messageQueue.send({
              id: crypto.randomUUID(),
              from: config.name,
              to: config.name,
              type: "task",
              content: reflectResult.decision.nextMessage,
              timestamp: Date.now(),
            });
          }
          break;
        }
        case "complete": {
          logComplete(config, reflectResult.decision.summary.outcome);
          await messageQueue.send({
            id: crypto.randomUUID(),
            from: config.name,
            to: "bob",
            type: "complete",
            content: reflectResult.decision.summary.outcome,
            timestamp: Date.now(),
          });
          // Soft compaction for final state
          if (compactionNeeded === "soft") {
            const compacted = contextManager.compactIterations(allStates, iteration);
            allStates.length = 0;
            allStates.push(...compacted);
          }
          return;
        }
        case "error": {
          selfRecoveryAttempts++;
          if (selfRecoveryAttempts >= MAX_SELF_RECOVERY) {
            logEscalation(config, `${MAX_SELF_RECOVERY} failed recovery attempts: ${reflectResult.decision.errorDetails ?? "unknown error"}`);
            await messageQueue.send({
              id: crypto.randomUUID(),
              from: config.name,
              to: "bob",
              type: "error",
              content: `Agent ${config.name} stuck after ${MAX_SELF_RECOVERY} recovery attempts: ${reflectResult.decision.errorDetails ?? "unknown error"}`,
              timestamp: Date.now(),
            });
            selfRecoveryAttempts = 0;
          } else {
            logRecovery(config, selfRecoveryAttempts, MAX_SELF_RECOVERY);
            // Post retry message to own queue
            await messageQueue.send({
              id: crypto.randomUUID(),
              from: config.name,
              to: config.name,
              type: "task",
              content: `Retry: ${reflectResult.decision.errorDetails ?? "previous attempt failed"}`,
              timestamp: Date.now(),
            });
          }
          break;
        }
      }
    } catch (err) {
      logError(config, `Iteration ${iteration}: ${err instanceof Error ? err.message : String(err)}`);
      selfRecoveryAttempts++;
      if (selfRecoveryAttempts >= MAX_SELF_RECOVERY) {
        await messageQueue.send({
          id: crypto.randomUUID(),
          from: config.name,
          to: "bob",
          type: "error",
          content: `Agent ${config.name} crashed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        });
        return;
      }
      // Self-queue a retry
      await messageQueue.send({
        id: crypto.randomUUID(),
        from: config.name,
        to: config.name,
        type: "task",
        content: `Retry after error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    }

    iteration++;
  }

  logMaxIterations(config, config.maxIterations);
}

// ─── Step Implementations ────────────────────────────────────────

interface StepResult {
  output: unknown;
  tokensUsed: TokenUsage;
  plan: string;
  complexity: "simple" | "complex";
}

async function doPlan(
  config: AgentConfig,
  deps: LifeLoopDeps,
  allStates: IterationState[],
  currentMessages: QueueMessage[],
  iteration: number,
): Promise<StepResult> {
  const systemPrompt = buildSystemPrompt(config, planPrompt(config));
  const messages = deps.contextManager.assembleContext({
    iterationStates: allStates,
    currentMessages,
    currentIteration: iteration,
  });

  const finalMessages = ensureMessages(messages, "What is your plan for this iteration?");
  logContextAssembly(config, allStates.length, currentMessages.length, finalMessages.length, finalMessages.map(m => m.role));
  logApiCall(config, "plan", finalMessages.length, finalMessages.map(m => m.role), false);

  const { response, tokensUsed } = await deps.claudeClient.call({
    model: config.model,
    systemPrompt,
    messages: finalMessages,
  });
  logApiResult(config, "plan", tokensUsed, response.stop_reason ?? "unknown", response.content.map(b => b.type));

  const text = getTextContent(response);
  const parsed = safeParseJson(text);
  const plan = typeof parsed?.plan === "string" ? parsed.plan : text;
  const complexity = parsed?.complexity === "simple" ? "simple" : "complex";

  return { output: parsed ?? text, tokensUsed, plan, complexity };
}

async function doExecute(
  config: AgentConfig,
  deps: LifeLoopDeps,
  allStates: IterationState[],
  plan: string,
  iteration: number,
): Promise<StepResult> {
  const systemPrompt = buildSystemPrompt(config, executePrompt(config, plan));
  const tools = deps.toolRegistry.getAllToolsForApi(config.tools);
  const messages = deps.contextManager.assembleContext({
    iterationStates: allStates,
    currentMessages: [],
    currentIteration: iteration,
  });

  const finalMessages = ensureMessages(messages, "Execute the plan now.");
  logContextAssembly(config, allStates.length, 0, finalMessages.length, finalMessages.map(m => m.role));
  logDebug(config, `execute: ${tools.length} tools available`);

  const result = await executeWithToolLoop(
    config, deps, systemPrompt,
    finalMessages,
    tools,
  );

  return { output: result.output, tokensUsed: result.tokensUsed, plan, complexity: "complex" };
}

async function doPlanExecute(
  config: AgentConfig,
  deps: LifeLoopDeps,
  allStates: IterationState[],
  currentMessages: QueueMessage[],
  iteration: number,
): Promise<StepResult> {
  const systemPrompt = buildSystemPrompt(config, planExecutePrompt(config));
  const tools = deps.toolRegistry.getAllToolsForApi(config.tools);
  const messages = deps.contextManager.assembleContext({
    iterationStates: allStates,
    currentMessages,
    currentIteration: iteration,
  });

  const finalMessages = ensureMessages(messages, "Proceed with the fast-path iteration.");
  logContextAssembly(config, allStates.length, currentMessages.length, finalMessages.length, finalMessages.map(m => m.role));
  logDebug(config, `plan-execute: ${tools.length} tools available`);

  const result = await executeWithToolLoop(
    config, deps, systemPrompt,
    finalMessages,
    tools,
  );

  // Try to extract complexity from the response text
  const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  const parsed = safeParseJson(text);
  const complexity = parsed?.complexity === "complex" ? "complex" : "simple";

  return { output: result.output, tokensUsed: result.tokensUsed, plan: text, complexity };
}

async function doReflect(
  config: AgentConfig,
  deps: LifeLoopDeps,
  allStates: IterationState[],
  iteration: number,
): Promise<{ decision: ReflectDecision; tokensUsed: TokenUsage; complexity: "simple" | "complex" }> {
  const systemPrompt = buildSystemPrompt(config, reflectPrompt(config));
  const messages = deps.contextManager.assembleContext({
    iterationStates: allStates,
    currentMessages: [],
    currentIteration: iteration,
  });

  const finalMessages = ensureMessages(messages, "Reflect on this iteration's results.");
  logContextAssembly(config, allStates.length, 0, finalMessages.length, finalMessages.map(m => m.role));
  logApiCall(config, "reflect", finalMessages.length, finalMessages.map(m => m.role), false);

  const { response, tokensUsed } = await deps.claudeClient.call({
    model: config.model,
    systemPrompt,
    messages: finalMessages,
  });
  logApiResult(config, "reflect", tokensUsed, response.stop_reason ?? "unknown", response.content.map(b => b.type));

  const text = getTextContent(response);
  const parsed = safeParseJson(text);

  const validDecisions = ["continue", "complete", "error"] as const;
  const rawDecision = parsed?.decision as string | undefined;
  const parsedDecision = validDecisions.includes(rawDecision as typeof validDecisions[number])
    ? (rawDecision as ReflectDecision["decision"])
    : "continue";

  const decision: ReflectDecision = parsed
    ? {
        decision: parsedDecision,
        summary: (parsed.summary as ReflectDecision["summary"]) ?? {
          iteration,
          plan: "Unknown",
          outcome: "Unknown",
          filesChanged: [],
          decisions: [],
        },
        nextMessage: parsed.nextMessage as string | undefined,
        errorDetails: parsed.errorDetails as string | undefined,
        selfRecoveryAttempt: parsed.selfRecoveryAttempt as number | undefined,
      }
    : {
        decision: "continue",
        summary: {
          iteration,
          plan: "Could not parse reflection",
          outcome: text.slice(0, 200),
          filesChanged: [],
          decisions: [],
        },
        nextMessage: "Retry — reflection output was not valid JSON.",
      };

  // Determine complexity for next iteration from the plan states
  const planState = allStates.find(
    (s) => s.iteration === iteration && (s.step === "plan" || s.step === "plan-execute"),
  );
  const complexity =
    planState?.complexity === "simple" ? "simple" : "complex";

  return { decision, tokensUsed, complexity };
}

// ─── Tool Call Loop ──────────────────────────────────────────────

async function executeWithToolLoop(
  config: AgentConfig,
  deps: LifeLoopDeps,
  systemPrompt: string,
  messages: MessageParam[],
  tools: ToolUnion[],
): Promise<{ output: unknown; tokensUsed: TokenUsage }> {
  let currentMessages = [...messages];
  let totalTokens: TokenUsage = { input: 0, output: 0 };
  let turns = 0;

  while (turns < MAX_TOOL_TURNS) {
    logApiCall(config, `execute/turn-${turns}`, currentMessages.length, currentMessages.map(m => m.role), tools.length > 0);

    const { response, tokensUsed } = await deps.claudeClient.call({
      model: config.model,
      systemPrompt,
      messages: currentMessages,
      tools: tools.length > 0 ? tools : undefined,
    });
    totalTokens = addTokens(totalTokens, tokensUsed);
    logApiResult(config, `execute/turn-${turns}`, tokensUsed, response.stop_reason ?? "unknown", response.content.map(b => b.type));

    // Check for tool use blocks
    const toolUseBlocks = getToolUseBlocks(response);
    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      logDebug(config, `execute done after ${turns + 1} turns, total ${totalTokens.input}+${totalTokens.output} tokens`);
      // No more tool calls — return the final response
      return {
        output: getTextContent(response) || response.content,
        tokensUsed: totalTokens,
      };
    }

    // Process tool calls
    logDebug(config, `${toolUseBlocks.length} tool call(s): ${toolUseBlocks.map(b => b.name).join(", ")}`);
    const toolResults: MessageParam["content"] = [];
    for (const block of toolUseBlocks) {
      if (deps.toolRegistry.isServerTool(block.name)) {
        logDebug(config, `server tool ${block.name} (handled by API)`);
        // Server-side tools are handled by the API — results are in the response
        continue;
      }

      logToolCall(config, block.name);
      let result: string;
      try {
        result = await deps.toolRegistry.executeTool(
          block.name,
          block.input as Record<string, unknown>,
        );
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      logToolResult(config, block.name, result);

      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: block.id,
        content: result,
      });
    }

    // Append assistant response and tool results to messages
    currentMessages = [
      ...currentMessages,
      { role: "assistant" as const, content: response.content as ContentBlock[] },
      { role: "user" as const, content: toolResults as MessageParam["content"] },
    ];

    turns++;
  }

  // Hit max tool turns
  return {
    output: `Tool loop terminated after ${MAX_TOOL_TURNS} turns`,
    tokensUsed: totalTokens,
  };
}

// ─── Cancellation ────────────────────────────────────────────────

async function handleCancellation(
  config: AgentConfig,
  message: QueueMessage,
  messageQueue: MessageQueue,
  allStates: IterationState[],
  iteration: number,
  agentDir: string,
): Promise<void> {
  // Write cancellation state
  const cancelState: IterationState = {
    iteration,
    step: "reflect",
    timestamp: Date.now(),
    input: message,
    output: { decision: "complete", cancelled: true, reason: message.content },
    tokensUsed: { input: 0, output: 0 },
  };
  await writeIterationState(agentDir, iteration, "reflect", cancelState);

  // Commit any in-progress work
  try {
    await Bun.$`git -C ${agentDir} add -A`.quiet().nothrow();
    await Bun.$`git -C ${agentDir} commit -m "WIP: cancelled" --allow-empty`.quiet().nothrow();
  } catch {
    // Best effort
  }

  // Notify leader
  await messageQueue.send({
    id: crypto.randomUUID(),
    from: config.name,
    to: "bob",
    type: "complete",
    content: JSON.stringify({ cancelled: true, reason: message.content }),
    timestamp: Date.now(),
  });

  logCancel(config, "exiting");
}

// ─── Crash Recovery ──────────────────────────────────────────────

async function recoverState(
  agentDir: string,
  resumeFrom: string,
  allStates: IterationState[],
): Promise<{ iteration: number; lastComplexity: "simple" | "complex" }> {
  // Parse "iteration-step" format
  const match = resumeFrom.match(/^(\d+)-(.+)$/);
  if (!match) {
    return { iteration: 1, lastComplexity: "complex" };
  }

  const resumeIteration = parseInt(match[1]!, 10);
  const resumeStep = match[2] as StepType;

  // Load all existing states up to the resume point
  for (let i = 1; i <= resumeIteration; i++) {
    for (const step of ["plan", "execute", "plan-execute", "reflect"] as StepType[]) {
      const state = await readIterationState(agentDir, i, step);
      if (state) {
        allStates.push(state);
      }
    }
  }

  // Determine which iteration to continue from
  // If the last step was reflect, start next iteration
  // Otherwise, retry the current iteration
  if (resumeStep === "reflect") {
    const lastState = allStates[allStates.length - 1];
    const lastComplexity = lastState?.complexity ?? "complex";
    return {
      iteration: resumeIteration + 1,
      lastComplexity: lastComplexity as "simple" | "complex",
    };
  }

  return { iteration: resumeIteration, lastComplexity: "complex" };
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildSystemPrompt(config: AgentConfig, basePrompt: string): string {
  let prompt = basePrompt;
  if (config.name === "bob") {
    // Leader gets additional context about team management
    const maxWorkers = 6; // Default, could be passed through config
    prompt += "\n\n" + leaderContextPrompt(maxWorkers);
  }
  return prompt;
}

/**
 * Ensure the messages array is non-empty, starts with a user message,
 * and ends with a user message. Some models (e.g. Opus) do not support
 * assistant message prefill, so the conversation must end with a user turn.
 */
function ensureMessages(
  messages: MessageParam[],
  fallbackContent: string,
): MessageParam[] {
  if (messages.length === 0) {
    return [{ role: "user", content: fallbackContent }];
  }
  let result = messages;
  let modified = false;
  // If first message is not user role, prepend a user message
  if (result[0]!.role !== "user") {
    result = [{ role: "user", content: fallbackContent }, ...result];
    modified = true;
  }
  // If last message is not user role, append a user message
  if (result[result.length - 1]!.role !== "user") {
    result = [...result, { role: "user", content: fallbackContent }];
    modified = true;
  }
  if (modified) {
    console.log(`[ensureMessages] fixed: ${messages.length} → ${result.length} msgs, roles: [${result.map(m => m.role).join(",")}]`);
  }
  return result;
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    // Try to extract JSON from the text (handle markdown code blocks)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const toParse = jsonMatch ? jsonMatch[1]!.trim() : text.trim();
    return JSON.parse(toParse) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output };
}

// ─── Subprocess Entry Point ──────────────────────────────────────

if (import.meta.main) {
  const configJson = process.env.AGENT_CONFIG;
  if (!configJson) {
    console.error("AGENT_CONFIG environment variable is required");
    process.exit(1);
  }

  const config = JSON.parse(configJson) as AgentConfig;

  // Create dependencies
  const claudeClient = new ClaudeClient();
  const messageQueue = new MessageQueue(config.valkeyUrl);
  const toolRegistry = new ToolRegistry();
  const contextManager = new ContextManager(config.model);

  toolRegistry.loadBuiltins();
  toolRegistry.bindAgentContext({
    agentName: config.name,
    workDir: `${config.workspacePath}/${config.name}`,
    messageQueue,
    workspacePath: config.workspacePath,
    spawnContext:
      config.name === "bob"
        ? {
            workspacePath: config.workspacePath,
            valkeyUrl: config.valkeyUrl,
            defaultModel: process.env.SEALTEAM_TEAM_MODEL ?? "claude-sonnet-4-6",
            defaultBudget: parseInt(process.env.SEALTEAM_DEFAULT_BUDGET ?? "100000", 10),
            defaultMaxIterations: parseInt(process.env.SEALTEAM_DEFAULT_MAX_ITERATIONS ?? "50", 10),
            maxWorkers: parseInt(process.env.SEALTEAM_MAX_AGENTS ?? "6", 10),
          }
        : undefined,
  });

  const deps: LifeLoopDeps = { claudeClient, messageQueue, toolRegistry, contextManager };

  runLifeLoop(config, deps)
    .then(() => {
      messageQueue.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error(`Agent ${config.name} fatal error:`, err);
      messageQueue.close();
      process.exit(1);
    });
}
