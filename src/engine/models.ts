import { createOpenAI } from "@ai-sdk/openai";
import { defaultChatContextWindow } from "./context.js";

export function createModels(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const provider = env.SARA_MODEL_PROVIDER ?? (apiKey ? "openai" : "ollama");
  const contextWindow = Number(env.SARA_CHAT_CONTEXT_WINDOW ?? defaultChatContextWindow);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1) {
    throw new Error("SARA_CHAT_CONTEXT_WINDOW must be a positive integer in tokens.");
  }

  if (provider === "ollama") {
    const ollama = createOpenAI({
      apiKey: "ollama", // The SDK requires a value. Ollama ignores it.
      baseURL: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
      name: "ollama",
    });
    const defaultModel = "qwen3.5:9b";
    return {
      provider,
      contextWindow,
      chat: ollama.chat(env.SARA_CHAT_MODEL ?? defaultModel),
      memory: ollama.chat(env.SARA_MEMORY_MODEL ?? defaultModel),
    };
  }

  if (provider !== "openai") throw new Error("SARA_MODEL_PROVIDER must be ollama or openai.");
  if (!apiKey) throw new Error("Set OPENAI_API_KEY in .env to use the OpenAI provider.");
  const openai = createOpenAI({ apiKey, baseURL: env.OPENAI_BASE_URL });
  return {
    provider,
    contextWindow,
    chat: openai.responses(env.SARA_CHAT_MODEL ?? "gpt-6.1-terra"),
    memory: openai.responses(env.SARA_MEMORY_MODEL ?? "gpt-6-luna"),
  };
}
