import { runAgentLoopContinue, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createModels,
  EventStream,
  hasApi,
  toToolDeclaration,
  type AssistantMessage,
  type Message,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { Channel, ChatMessage, SaraDatabase } from "../db.js";
import { calculateEmi } from "../tools/emi.js";
import { lookupFinance } from "../tools/financeKb.js";
import { findUngroundedFinanceNumbers } from "./financeNumbers.js";
import { buildPrompt } from "./prompt.js";

interface TurnInput {
  userId: string;
  channel: Channel;
  utterances: readonly ChatMessage[];
  signal: AbortSignal;
}

export type TurnEvent =
  | { type: "delta"; delta: string }
  | { type: "complete"; messages: (AssistantMessage | ToolResultMessage)[] };

export interface TurnEngine {
  run(input: TurnInput): AsyncIterable<TurnEvent>;
}

interface TurnOptions {
  modelId: string;
  reasoning: "none" | "low";
  apiKey: string;
  baseUrl?: string;
  tools?: AgentTool[];
  maxTokens?: number;
}

export function createTurnEngine(database: SaraDatabase, options: TurnOptions): TurnEngine {
  const models = createModels();
  models.setProvider(openaiProvider());
  const catalog = models.getModel("openai", options.modelId);
  if (!catalog || !hasApi(catalog, "openai-responses")) {
    throw new Error(`Unsupported OpenAI Responses model: ${options.modelId}`);
  }
  const model = {
    ...catalog,
    baseUrl: options.baseUrl ?? catalog.baseUrl,
    // Send effort on the request itself so rebuilding a turn keeps the same input prefix.
    compat: { ...catalog.compat, supportsMidConvoEffort: false },
  };
  const tools = options.tools ?? [calculateEmi, lookupFinance];
  const declarations = tools.map(toToolDeclaration);

  return {
    async *run({ userId, channel, utterances, signal }) {
      signal.throwIfAborted();
      const first = utterances[0];
      if (!first) throw new Error("A Sara turn needs at least one persisted user message.");
      const previous = database.getModelHistory(userId, Math.max(0, 12 - utterances.length), first.id);
      const messages: Message[] = [
        { role: "system", content: buildPrompt(channel), toolsAdded: declarations, timestamp: Date.now() },
        ...previous,
        ...utterances.map(({ content, createdAt }) => ({
          role: "user" as const,
          content,
          timestamp: Date.parse(createdAt),
        })),
      ];

      const events = new EventStream<TurnEvent, void>(() => false, () => undefined);
      const outcome = runAgentLoopContinue(
        { messages, tools },
        {
          model,
          reasoning: options.reasoning === "low" ? "low" : undefined,
          maxTokens: options.maxTokens ?? 120,
          convertToLlm: (messages) => messages,
          apiKey: options.apiKey,
        },
        (event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            events.push({ type: "delta", delta: event.assistantMessageEvent.delta });
          }
        },
        signal,
        models.streamSimple.bind(models),
      ).then(
        (messages) => ({ messages }),
        (error: unknown) => ({ error }),
      ).finally(() => events.end());

      yield* events;
      signal.throwIfAborted();
      const result = await outcome;
      if ("error" in result) throw result.error;

      const replies = result.messages.filter(
        (message) => message.role === "assistant" || message.role === "toolResult",
      );
      const last = replies.at(-1);
      if (last?.role !== "assistant" || (last.stopReason !== "stop" && last.stopReason !== "length")) {
        throw new Error(last?.role === "assistant" ? last.errorMessage ?? "Model turn failed." : "Model turn failed.");
      }
      if (!last.content.some((part) => part.type === "text" && part.text.trim())) {
        throw new Error("The model finished without a reply.");
      }

      const financeSources = [...messages, ...replies].flatMap((message) => {
        if (message.role === "user" && typeof message.content === "string") return [message.content];
        if (message.role === "toolResult" && !message.isError &&
            (message.toolName === calculateEmi.name || message.toolName === lookupFinance.name)) {
          return message.content.flatMap((part) => part.type === "text" ? [part.text] : []);
        }
        return [];
      });
      const replyText = replies.flatMap((message) => message.role === "assistant" ? message.content : [])
        .flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      const ungrounded = findUngroundedFinanceNumbers(replyText, financeSources);
      if (ungrounded.length) console.warn(`Sara reply contains ${ungrounded.length} ungrounded finance figure(s).`);

      yield { type: "complete", messages: replies };
    },
  };
}
