import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";

export interface MemoryEmbedder {
  readonly id: string;
  embed(texts: readonly string[], kind: "fact" | "query", signal?: AbortSignal): Promise<number[][]>;
}

const queryInstruction = "Find stored English facts that answer the user's current message. Understand Hindi and Hinglish written in Latin or Devanagari characters and use the recent dialogue to resolve references.";

export function createMemoryEmbedder(env: NodeJS.ProcessEnv = process.env): MemoryEmbedder {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const provider = env.SARA_MODEL_PROVIDER ?? (apiKey ? "openai" : "ollama");
  if (provider !== "ollama" && provider !== "openai") {
    throw new Error("SARA_MODEL_PROVIDER must be ollama or openai.");
  }
  if (provider === "openai" && !apiKey) {
    throw new Error("Set OPENAI_API_KEY in .env to use the OpenAI provider.");
  }

  const client = createOpenAI(provider === "ollama" ? {
    apiKey: "ollama",
    baseURL: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
    name: provider,
  } : { apiKey, baseURL: env.OPENAI_BASE_URL });
  const modelId = env.SARA_EMBEDDING_MODEL?.trim()
    || (provider === "ollama" ? "qwen3-embedding:0.6b" : "text-embedding-3-small");
  const model = client.embedding(modelId);
  const instructQueries = /(?:^|\/)qwen3-embedding(?:[:@-]|$)/i.test(modelId);

  return {
    id: `${provider}/${modelId}`,
    async embed(texts, kind, signal) {
      signal?.throwIfAborted();
      if (!texts.length) return [];
      const blendQuery = kind === "query" && instructQueries;
      const values = [...texts];
      if (blendQuery) values.push(...texts.map((text) => `Instruct: ${queryInstruction}\nQuery: ${text}`));
      const timeout = AbortSignal.timeout(kind === "query" ? 2500 : 20_000);
      const { embeddings } = await embedMany({
        model,
        values,
        abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        maxRetries: 0,
      });
      const dimensions = embeddings[0]?.length;
      if (!dimensions || embeddings.length !== values.length || embeddings.some((vector) => (
        vector.length !== dimensions || !vector.every(Number.isFinite) || !vector.some((value) => value !== 0)
      ))) {
        throw new Error("Memory embedding model returned invalid vectors.");
      }
      if (!blendQuery) return embeddings;

      // Combining both query forms in one request improved recall on Romanized Hindi.
      return embeddings.slice(texts.length).map((instructed, index) => {
        const original = embeddings[index];
        return instructed.map((value, dimension) => 0.75 * value + 0.25 * original[dimension]);
      });
    },
  };
}
