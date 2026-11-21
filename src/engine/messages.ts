import type { AssistantModelMessage, ModelMessage, ToolModelMessage, ToolResultPart } from "ai";

type ResponseMessage = AssistantModelMessage | ToolModelMessage;

function storedToolResult({ type, toolCallId, toolName, output }: ToolResultPart): ToolResultPart {
  if (output.type === "content") {
    return {
      type,
      toolCallId,
      toolName,
      output: { type: "content", value: output.value.map(({ providerOptions: _, ...part }) => part) },
    };
  }
  const { providerOptions: _providerOptions, ...storedOutput } = output;
  return { type, toolCallId, toolName, output: storedOutput };
}

export function toStored(messages: readonly ResponseMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content
          .filter((part) => part.type === "tool-result")
          .map(storedToolResult),
      };
    }
    if (typeof message.content === "string") {
      return { role: "assistant", content: message.content };
    }

    const content: Exclude<typeof message.content, string> = [];
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          content.push({ type: part.type, text: part.text });
          break;
        case "tool-call":
          content.push({ type: part.type, toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
          break;
        case "tool-result":
          content.push(storedToolResult(part));
          break;
      }
    }
    return { role: "assistant", content };
  });
}

export function assistantText(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .map(({ content }) => typeof content === "string"
      ? content
      : content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))
    .join("");
}
