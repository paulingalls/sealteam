import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "./types.ts";
import { logRetry } from "./logger.ts";

// Re-export SDK types used by callers
export type Message = Anthropic.Messages.Message;
export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ToolUnion = Anthropic.Messages.ToolUnion;
export type TextBlock = Anthropic.Messages.TextBlock;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

export interface CallParams {
  model: string;
  systemPrompt: string;
  messages: MessageParam[];
  tools?: ToolUnion[];
  maxTokens?: number;
}

export interface CallResult {
  response: Message;
  tokensUsed: TokenUsage;
}

// Context window sizes per model family
const CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
};
const DEFAULT_CONTEXT_LIMIT = 200000;

export function getContextLimit(model: string): number {
  return CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class ClaudeClient {
  private client: Anthropic;
  private totalInput: number = 0;
  private totalOutput: number = 0;

  constructor() {
    // Anthropic SDK reads ANTHROPIC_API_KEY from env automatically
    this.client = new Anthropic();
  }

  /**
   * Make a single Claude API call with retry and exponential backoff
   * for transient errors (rate limits, network failures, server errors).
   */
  async call(params: CallParams): Promise<CallResult> {
    const { model, systemPrompt, messages, tools, maxTokens = 16384 } = params;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        });

        const tokensUsed: TokenUsage = {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        };

        this.totalInput += tokensUsed.input;
        this.totalOutput += tokensUsed.output;

        return { response, tokensUsed };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on client errors (4xx except 429 rate limit and 529 overloaded)
        if (isNonRetryableError(err)) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          logRetry("Claude API call", attempt, MAX_RETRIES, delayMs);
          await sleep(delayMs);
        }
      }
    }

    throw lastError ?? new Error("Claude API call failed after retries");
  }

  /**
   * Get cumulative token usage across all calls.
   */
  getTokenUsage(): TokenUsage & { total: number } {
    return {
      input: this.totalInput,
      output: this.totalOutput,
      total: this.totalInput + this.totalOutput,
    };
  }

  /**
   * Rough token estimate for context window planning.
   * Actual counts come from API responses.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ─── Helpers for working with response content blocks ────────────

export function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

export function getTextContent(response: Message): string {
  return response.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join("\n");
}

export function getToolUseBlocks(response: Message): ToolUseBlock[] {
  return response.content.filter(isToolUse);
}

// ─── Retry Helpers ───────────────────────────────────────────────

function isNonRetryableError(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    // Retry on: 429 (rate limit), 500+, 529 (overloaded)
    // Don't retry on: 400, 401, 403, 404, 422 (client errors)
    if (status >= 400 && status < 500 && status !== 429) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
