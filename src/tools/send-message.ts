import type { ToolDefinition, QueueMessage, MessageType } from "../types.ts";
import type { MessageQueue } from "../message-queue.ts";

export const definition: ToolDefinition = {
  name: "send-message",
  description:
    'Send a message to another agent\'s queue, the shared queue (all agents), or the main process. Use "shared" to broadcast to all active agents.',
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          'Recipient: an agent name, "shared" for all agents, or "main" for the main process',
      },
      type: {
        type: "string",
        enum: [
          "task",
          "status",
          "review",
          "complete",
          "error",
          "cancel",
          "all-complete",
        ],
        description: "Message type",
      },
      content: {
        type: "string",
        description: "Message body",
      },
    },
    required: ["to", "type", "content"],
  },
};

/**
 * Create a handler bound to a specific agent name, message queue, and workspace.
 */
export function createHandler(
  agentName: string,
  messageQueue: MessageQueue,
  workspacePath: string,
) {
  return async (input: Record<string, unknown>): Promise<string> => {
    const to = input.to as string;
    const type = input.type as MessageType;
    const content = input.content as string;

    const message: QueueMessage = {
      id: crypto.randomUUID(),
      from: agentName,
      to,
      type,
      content,
      timestamp: Date.now(),
    };

    await messageQueue.send(message, workspacePath);
    return `Message sent to ${to} (type: ${type})`;
  };
}

/**
 * Default handler — requires context via input fields.
 * Used only as a fallback; prefer createHandler for production use.
 */
export async function handler(
  _input: Record<string, unknown>,
): Promise<string> {
  throw new Error(
    "send-message requires a bound handler created via createHandler(). " +
      "The tool registry should set this up with the agent's message queue.",
  );
}
