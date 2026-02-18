import type { IterationState, IterationSummary, QueueMessage } from "./types.ts";
import type { MessageParam } from "./claude-client.ts";
import { getContextLimit } from "./claude-client.ts";

/** Number of recent iterations kept in full detail. */
const FULL_DETAIL_WINDOW = 5;

/** Iterations older than this have tool results trimmed. */
const TRIM_TOOL_RESULTS_AFTER = 3;

/** Max lines kept at head/tail of trimmed tool output. */
const TRIM_KEEP_LINES = 200;

/** Soft compaction trigger (background, next reflect). */
const SOFT_LIMIT_RATIO = 0.7;

/** Hard compaction trigger (immediate, before next call). */
const HARD_LIMIT_RATIO = 0.9;

export type CompactionLevel = "none" | "soft" | "hard";

export class ContextManager {
  private contextLimit: number;
  private currentTokenEstimate: number = 0;

  constructor(model: string) {
    this.contextLimit = getContextLimit(model);
  }

  /**
   * Assemble the messages array for a Claude API call.
   *
   * Structure:
   * 1. Compacted summaries of old iterations (older than FULL_DETAIL_WINDOW)
   * 2. Full detail of recent iterations (last FULL_DETAIL_WINDOW)
   * 3. Current queue messages
   */
  assembleContext(params: {
    iterationStates: IterationState[];
    currentMessages: QueueMessage[];
    currentIteration: number;
  }): MessageParam[] {
    const { iterationStates, currentMessages, currentIteration } = params;

    const messages: MessageParam[] = [];

    // Group states by iteration
    const byIteration = groupByIteration(iterationStates);
    const iterationNumbers = [...byIteration.keys()].sort((a, b) => a - b);

    const oldCutoff = currentIteration - FULL_DETAIL_WINDOW;
    const trimCutoff = currentIteration - TRIM_TOOL_RESULTS_AFTER;

    // 1. Old iterations → compacted summaries
    for (const iterNum of iterationNumbers) {
      if (iterNum > oldCutoff) break;
      const states = byIteration.get(iterNum)!;
      const summary = this.extractSummary(states, iterNum);
      if (summary) {
        messages.push({
          role: "user",
          content: `[Iteration ${iterNum} summary] Plan: ${summary.plan} | Outcome: ${summary.outcome}${summary.filesChanged.length > 0 ? ` | Files: ${summary.filesChanged.join(", ")}` : ""}${summary.decisions.length > 0 ? ` | Decisions: ${summary.decisions.join("; ")}` : ""}`,
        });
        messages.push({
          role: "assistant",
          content: `Acknowledged iteration ${iterNum} summary.`,
        });
      }
    }

    // 2. Recent iterations → full detail (with tool result trimming for semi-old ones)
    for (const iterNum of iterationNumbers) {
      if (iterNum <= oldCutoff) continue;
      const states = byIteration.get(iterNum)!;

      for (const state of states) {
        const shouldTrim = iterNum <= trimCutoff;

        // Represent the state as a user message (input) + assistant message (output)
        const inputStr = formatStateInput(state, shouldTrim);
        const outputStr = formatStateOutput(state, shouldTrim);

        messages.push({ role: "user", content: inputStr });
        messages.push({ role: "assistant", content: outputStr });
      }
    }

    // 3. Current queue messages
    if (currentMessages.length > 0) {
      const msgText = currentMessages
        .map(
          (m) =>
            `[Message from ${m.from}] (type: ${m.type}) ${m.content}`,
        )
        .join("\n\n");
      messages.push({ role: "user", content: msgText });
    }

    // Update token estimate
    this.currentTokenEstimate = this.estimateMessagesTokens(messages);

    return messages;
  }

  /**
   * Check if compaction is needed based on current utilization.
   */
  checkCompactionNeeded(): CompactionLevel {
    const utilization = this.getUtilization();
    if (utilization >= HARD_LIMIT_RATIO) return "hard";
    if (utilization >= SOFT_LIMIT_RATIO) return "soft";
    return "none";
  }

  /**
   * Apply compaction to iteration states: trim tool results and
   * drop detail from old iterations. Returns a new array.
   */
  compactIterations(
    iterations: IterationState[],
    currentIteration: number,
  ): IterationState[] {
    const oldCutoff = currentIteration - FULL_DETAIL_WINDOW;
    const trimCutoff = currentIteration - TRIM_TOOL_RESULTS_AFTER;

    return iterations.map((state) => {
      if (state.iteration <= oldCutoff) {
        // Old iterations: summarize (keep only essential info)
        return summarizeState(state);
      }
      if (state.iteration <= trimCutoff) {
        // Semi-old: trim tool results
        return trimToolResults(state);
      }
      // Recent: keep as-is
      return state;
    });
  }

  /**
   * Update token estimate from an actual API response.
   */
  updateTokenUsage(inputTokens: number): void {
    this.currentTokenEstimate = inputTokens;
  }

  /**
   * Get current estimated utilization as a fraction (0–1).
   */
  getUtilization(): number {
    return this.currentTokenEstimate / this.contextLimit;
  }

  /**
   * Get the context limit for the model.
   */
  getContextLimit(): number {
    return this.contextLimit;
  }

  /**
   * Rough token estimate for a set of messages.
   */
  private estimateMessagesTokens(messages: MessageParam[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ("text" in block && typeof block.text === "string") {
            chars += block.text.length;
          } else {
            chars += 100; // rough estimate for non-text blocks
          }
        }
      }
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Extract an IterationSummary from a set of states for one iteration.
   * Prefers the reflect step's output (which should contain the summary).
   */
  private extractSummary(
    states: IterationState[],
    iteration: number,
  ): IterationSummary | null {
    // Look for a reflect state with a summary in its output
    const reflectState = states.find((s) => s.step === "reflect");
    if (reflectState?.output && typeof reflectState.output === "object") {
      const output = reflectState.output as Record<string, unknown>;
      if (output.summary && typeof output.summary === "object") {
        return output.summary as IterationSummary;
      }
    }

    // Fallback: build a minimal summary from available states
    const planState = states.find(
      (s) => s.step === "plan" || s.step === "plan-execute",
    );
    const executeState = states.find(
      (s) => s.step === "execute" || s.step === "plan-execute",
    );

    return {
      iteration,
      plan: planState ? truncateStr(JSON.stringify(planState.output), 200) : "Unknown",
      outcome: executeState
        ? truncateStr(JSON.stringify(executeState.output), 200)
        : reflectState
          ? truncateStr(JSON.stringify(reflectState.output), 200)
          : "Unknown",
      filesChanged: [],
      decisions: [],
    };
  }
}

// ─── Helper Functions ────────────────────────────────────────────

function groupByIteration(
  states: IterationState[],
): Map<number, IterationState[]> {
  const map = new Map<number, IterationState[]>();
  for (const state of states) {
    const list = map.get(state.iteration) || [];
    list.push(state);
    map.set(state.iteration, list);
  }
  return map;
}

function formatStateInput(state: IterationState, shouldTrim: boolean): string {
  const label = `[Iteration ${state.iteration} - ${state.step} input]`;
  let content = JSON.stringify(state.input);
  if (shouldTrim) {
    content = trimLargeText(content);
  }
  return `${label}\n${content}`;
}

function formatStateOutput(state: IterationState, shouldTrim: boolean): string {
  const label = `[Iteration ${state.iteration} - ${state.step} output]`;
  let content = JSON.stringify(state.output);
  if (shouldTrim) {
    content = trimLargeText(content);
  }
  return `${label}\n${content}`;
}

/**
 * Trim tool results in a state: truncate large text fields
 * in the output to first/last TRIM_KEEP_LINES lines.
 */
function trimToolResults(state: IterationState): IterationState {
  return {
    ...state,
    output: trimOutputValue(state.output),
    input: trimOutputValue(state.input),
  };
}

/**
 * Reduce a state to a minimal summarized form.
 */
function summarizeState(state: IterationState): IterationState {
  return {
    ...state,
    input: truncateStr(JSON.stringify(state.input), 300),
    output: truncateStr(JSON.stringify(state.output), 300),
  };
}

function trimOutputValue(value: unknown): unknown {
  if (typeof value === "string") {
    return trimLargeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(trimOutputValue);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = trimOutputValue(v);
    }
    return result;
  }
  return value;
}

/**
 * If text has more than TRIM_KEEP_LINES * 2 lines, keep only
 * the first and last TRIM_KEEP_LINES with an omission notice.
 */
function trimLargeText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= TRIM_KEEP_LINES * 2) return text;

  const omitted = lines.length - TRIM_KEEP_LINES * 2;
  return [
    ...lines.slice(0, TRIM_KEEP_LINES),
    `\n[... ${omitted} lines omitted ...]\n`,
    ...lines.slice(-TRIM_KEEP_LINES),
  ].join("\n");
}

function truncateStr(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}
