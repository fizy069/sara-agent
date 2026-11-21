import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { Channel, ChatMessage, SaraDatabase } from "../db.js";
import type { MemoryRetriever } from "../memory/retrieval.js";
import { createTools } from "../tools/index.js";
import { findUngroundedFinanceNumbers } from "./financeNumbers.js";
import { assistantText, toStored } from "./messages.js";
import { buildPrompt } from "./prompt.js";

interface TurnInput {
  userId: string;
  channel: Channel;
  utterances: readonly ChatMessage[];
  signal: AbortSignal;
}

export type TurnEvent =
  | { type: "delta"; delta: string }
  | { type: "tool"; name: string; phase: "start" | "end" }
  | { type: "complete"; messages: ModelMessage[] };

export interface TurnEngine {
  run(input: TurnInput): AsyncIterable<TurnEvent>;
}

interface TurnOptions {
  model: LanguageModel;
  reasoning: "none" | "low";
  tools?: ToolSet;
  maxTokens?: number;
  memory?: Pick<MemoryRetriever, "retrieve">;
}

const financeTools = new Set(["calculate_emi", "lookup_finance"]);

function replayedFinanceSources(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "user") {
      return typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
    }
    if (message.role !== "tool") return [];
    return message.content.flatMap((part) => {
      if (part.type !== "tool-result" || !financeTools.has(part.toolName)) return [];
      if (part.output.type === "text") return [part.output.value];
      if (part.output.type === "json") return [JSON.stringify(part.output.value)];
      return [];
    });
  });
}

export function createTurnEngine(database: SaraDatabase, options: TurnOptions): TurnEngine {
  return {
    async *run({ userId, channel, utterances, signal }) {
      signal.throwIfAborted();
      const first = utterances[0];
      if (!first) throw new Error("A Sara turn needs at least one persisted user message.");
      const sourceMessageId = utterances.at(-1)!.id;
      const previous = database.getModelHistory(userId, Math.max(0, 12 - utterances.length), first.id);
      const current = utterances.map(({ content }) => content);
      const memories = await options.memory?.retrieve(userId, previous, current, signal) ?? [];
      signal.throwIfAborted();
      const messages: ModelMessage[] = [
        ...previous,
        ...current.map((content) => ({ role: "user" as const, content })),
      ];
      const result = streamText({
        model: options.model,
        instructions: buildPrompt(channel, memories),
        messages,
        tools: options.tools ?? createTools({ store: database, userId, sourceMessageId }),
        stopWhen: isStepCount(4),
        maxOutputTokens: options.maxTokens ?? 120,
        reasoning: options.reasoning,
        toolCallConcurrency: 1,
        abortSignal: signal,
        providerOptions: { openai: { store: false, parallelToolCalls: false, promptCacheKey: userId } },
      });

      for await (const part of result.fullStream) {
        if (part.type === "abort") break;
        switch (part.type) {
          case "text-delta":
            yield { type: "delta", delta: part.text };
            break;
          case "tool-call":
            yield { type: "tool", name: part.toolName, phase: "start" };
            break;
          case "tool-result":
            yield { type: "tool", name: part.toolName, phase: "end" };
            break;
          case "error":
            throw part.error;
        }
      }

      signal.throwIfAborted();
      const finishReason = await result.finishReason;
      if (finishReason !== "stop" && finishReason !== "length") {
        throw new Error(`Model turn failed (${finishReason}).`);
      }

      const steps = await result.steps;
      // Each step owns its response messages, including tool exchanges before the final reply.
      const replies = toStored(steps.flatMap(({ response }) => response.messages));
      const last = replies.at(-1);
      if (last?.role !== "assistant" || !assistantText([last]).trim()) {
        throw new Error("The model finished without a reply.");
      }

      const financeSources = replayedFinanceSources(messages);
      for (const { toolResults } of steps) {
        for (const { toolName, output } of toolResults) {
          if (financeTools.has(toolName)) {
            financeSources.push(typeof output === "string" ? output : JSON.stringify(output) ?? "");
          }
        }
      }
      const ungrounded = findUngroundedFinanceNumbers(assistantText(replies), financeSources);
      if (ungrounded.length) console.warn(`Sara reply contains ${ungrounded.length} ungrounded finance figure(s).`);

      signal.throwIfAborted();
      yield { type: "complete", messages: replies };
    },
  };
}
