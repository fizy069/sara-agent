import { isDeepStrictEqual } from "node:util";
import type { ModelMessage, ToolCallPart, ToolResultPart } from "ai";
import type { ExpectedToolCall } from "./cases.js";

export function checkToolCalls(messages: readonly ModelMessage[], expected: readonly ExpectedToolCall[]) {
  const calls: ToolCallPart[] = [];
  const results = new Map<string, ToolResultPart>();
  for (const { role, content } of messages) {
    if (role !== "assistant" && role !== "tool") continue;
    if (typeof content === "string") continue;
    for (const part of content) {
      if (part.type === "tool-call") calls.push(part);
      if (part.type === "tool-result") results.set(part.toolCallId, part);
    }
  }

  const toolCalls = calls.map(({ toolCallId, toolName, input }) => {
    const result = results.get(toolCallId);
    return { name: toolName, input, output: result?.toolName === toolName ? result.output : undefined };
  });
  const issues: string[] = [];
  if (calls.length !== expected.length) {
    const names = (list: readonly { name: string }[]) => list.map(({ name }) => name).join(", ") || "none";
    issues.push(`Expected tool calls: ${names(expected)}. Observed: ${names(toolCalls)}.`);
  }
  for (const [index, requirement] of expected.entries()) {
    const call = toolCalls[index];
    if (call?.name !== requirement.name) {
      issues.push(`Tool call ${index + 1} should be ${requirement.name}.`);
      continue;
    }
    if (requirement.input && !isDeepStrictEqual(call.input, requirement.input)) {
      issues.push(`${call.name} expected ${JSON.stringify(requirement.input)}, got ${JSON.stringify(call.input)}.`);
    }
    if (requirement.inputQuery) {
      const input = call.input as { query?: unknown } | undefined;
      if (typeof input?.query !== "string" || !requirement.inputQuery.test(input.query)) {
        issues.push(`${call.name} should use an English query matching ${requirement.inputQuery}.`);
      }
    }
    const output = call.output;
    if (output?.type !== "text" && output?.type !== "json" && output?.type !== "content") {
      issues.push(`${call.name} did not return a successful result.`);
    } else if (requirement.resultTextIncludes && !JSON.stringify(output.value).includes(requirement.resultTextIncludes)) {
      issues.push(`${call.name} result should include ${requirement.resultTextIncludes}.`);
    }
  }
  return { toolCalls, issues };
}
