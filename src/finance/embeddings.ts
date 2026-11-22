import { z } from "zod";

const embeddingModel = "qwen3-embedding:0.6b";
export const financeEmbeddingDimensions = 1024;
const embeddingResponse = z.object({
  embeddings: z.array(z.array(z.number()).length(financeEmbeddingDimensions)),
});

export async function embedFinanceText(input: string[], signal: AbortSignal): Promise<number[][]> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
  const url = new URL(base);
  const path = url.pathname.replace(/\/$/, "").replace(/\/v1$/, "");
  url.pathname = `${path}/api/embed`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: embeddingModel, input, truncate: false }),
    signal,
  });
  if (!response.ok) throw new Error(`Ollama embedding request failed with HTTP ${response.status}.`);
  const { embeddings } = embeddingResponse.parse(await response.json());
  if (embeddings.length !== input.length) throw new Error("Ollama returned an unexpected number of embeddings.");
  return embeddings;
}

export async function embedFinanceQuery(query: string, signal: AbortSignal): Promise<number[]> {
  const input = `Instruct: Given a question about personal or small-business finance in India, retrieve a source document that answers the question.\nQuery: ${query}`;
  const [embedding] = await embedFinanceText([input], signal);
  return embedding;
}
