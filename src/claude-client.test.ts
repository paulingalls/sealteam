import { test, expect, describe } from "bun:test";
import {
  ClaudeClient,
  getContextLimit,
  isToolUse,
  isTextBlock,
  getTextContent,
  getToolUseBlocks,
} from "./claude-client.ts";
import type { Message, ContentBlock, ToolUnion } from "./claude-client.ts";

const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

describe("ClaudeClient unit tests", () => {
  test("instantiates without error when API key is set", () => {
    if (!hasApiKey) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }
    const client = new ClaudeClient();
    expect(client).toBeDefined();
  });

  test("getTokenUsage starts at zero", () => {
    if (!hasApiKey) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }
    const client = new ClaudeClient();
    const usage = client.getTokenUsage();
    expect(usage.input).toBe(0);
    expect(usage.output).toBe(0);
    expect(usage.total).toBe(0);
  });

  test("estimateTokens returns rough estimate", () => {
    if (!hasApiKey) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }
    const client = new ClaudeClient();
    const est = client.estimateTokens("hello world"); // 11 chars
    expect(est).toBe(3); // ceil(11/4)

    const est2 = client.estimateTokens("a".repeat(400));
    expect(est2).toBe(100);
  });

  test("getContextLimit returns known limits", () => {
    expect(getContextLimit("claude-opus-4-20250514")).toBe(200000);
    expect(getContextLimit("claude-sonnet-4-20250514")).toBe(200000);
  });

  test("getContextLimit returns default for unknown model", () => {
    expect(getContextLimit("claude-unknown-99")).toBe(200000);
  });
});

describe("content block helpers", () => {
  test("isTextBlock identifies text blocks", () => {
    const textBlock: ContentBlock = {
      type: "text",
      text: "hello",
      citations: null,
    };
    expect(isTextBlock(textBlock)).toBe(true);
    expect(isToolUse(textBlock)).toBe(false);
  });

  test("isToolUse identifies tool_use blocks", () => {
    const toolBlock: ContentBlock = {
      type: "tool_use",
      id: "tu_123",
      name: "bash",
      input: { command: "ls" },
    } as ContentBlock;
    expect(isToolUse(toolBlock)).toBe(true);
    expect(isTextBlock(toolBlock)).toBe(false);
  });

  test("getTextContent extracts text from response", () => {
    const response = {
      content: [
        { type: "text", text: "Hello ", citations: null },
        { type: "text", text: "World", citations: null },
      ],
    } as Message;
    expect(getTextContent(response)).toBe("Hello \nWorld");
  });

  test("getTextContent ignores non-text blocks", () => {
    const response = {
      content: [
        { type: "text", text: "Result:", citations: null },
        { type: "tool_use", id: "tu_1", name: "bash", input: {} },
      ],
    } as Message;
    expect(getTextContent(response)).toBe("Result:");
  });

  test("getToolUseBlocks extracts tool_use blocks", () => {
    const response = {
      content: [
        { type: "text", text: "Let me run that", citations: null },
        { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
        { type: "tool_use", id: "tu_2", name: "read-file", input: { path: "/tmp/x" } },
      ],
    } as Message;
    const blocks = getToolUseBlocks(response);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.name).toBe("bash");
    expect(blocks[1]!.name).toBe("read-file");
  });
});

describe("ClaudeClient integration tests", () => {
  test("simple API call returns valid response with token counts", async () => {
    if (!hasApiKey) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }
    const client = new ClaudeClient();
    const result = await client.call({
      model: "claude-sonnet-4-20250514",
      systemPrompt: "You are a helpful assistant. Be extremely brief.",
      messages: [{ role: "user", content: "Say hello in exactly 3 words." }],
      maxTokens: 64,
    });

    expect(result.response).toBeDefined();
    expect(result.response.role).toBe("assistant");
    expect(result.response.content.length).toBeGreaterThan(0);
    expect(result.tokensUsed.input).toBeGreaterThan(0);
    expect(result.tokensUsed.output).toBeGreaterThan(0);

    // Token usage should be tracked
    const usage = client.getTokenUsage();
    expect(usage.input).toBe(result.tokensUsed.input);
    expect(usage.output).toBe(result.tokensUsed.output);
    expect(usage.total).toBe(result.tokensUsed.input + result.tokensUsed.output);
  });

  test("call with tool definitions returns tool_use blocks", async () => {
    if (!hasApiKey) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }
    const client = new ClaudeClient();

    const tools: ToolUnion[] = [
      {
        name: "get_weather",
        description: "Get the current weather for a city",
        input_schema: {
          type: "object" as const,
          properties: {
            city: { type: "string", description: "The city name" },
          },
          required: ["city"],
        },
      },
    ];

    const result = await client.call({
      model: "claude-sonnet-4-20250514",
      systemPrompt: "You have access to a weather tool. Use it when asked about weather.",
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools,
      maxTokens: 256,
    });

    expect(result.response.stop_reason).toBe("tool_use");
    const toolBlocks = getToolUseBlocks(result.response);
    expect(toolBlocks.length).toBeGreaterThan(0);
    expect(toolBlocks[0]!.name).toBe("get_weather");
    expect((toolBlocks[0]!.input as Record<string, string>).city).toBeDefined();
  });

  test("cumulative token tracking across multiple calls", async () => {
    if (!hasApiKey) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }
    const client = new ClaudeClient();

    await client.call({
      model: "claude-sonnet-4-20250514",
      systemPrompt: "Be brief.",
      messages: [{ role: "user", content: "Say 'one'." }],
      maxTokens: 32,
    });

    const usage1 = client.getTokenUsage();
    expect(usage1.total).toBeGreaterThan(0);

    await client.call({
      model: "claude-sonnet-4-20250514",
      systemPrompt: "Be brief.",
      messages: [{ role: "user", content: "Say 'two'." }],
      maxTokens: 32,
    });

    const usage2 = client.getTokenUsage();
    expect(usage2.total).toBeGreaterThan(usage1.total);
  });
});
