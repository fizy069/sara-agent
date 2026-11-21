import { setTimeout as wait } from "node:timers/promises";
import type { ModelMessage } from "ai";
import type { MemoryEmbedder } from "./embeddings.js";
import type { MemoryFact } from "./operations.js";
import type { MemoryVectorStore } from "./store.js";

export interface MemoryRetriever {
  retrieve(
    userId: string,
    previous: readonly ModelMessage[],
    utterances: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemoryFact[]>;
  index(userId: string): Promise<void>;
}

const maxResults = 5;
const batchSize = 32;
const indexWaitMs = 2_500;

function recentText(messages: readonly ModelMessage[], limit: number): string[] {
  const context: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = typeof message.content === "string" ? message.content : message.content
      .flatMap((part) => part.type === "text" ? [part.text] : []).join(" ");
    if (content.trim()) context.unshift(`${message.role}: ${content.trim().slice(-500)}`);
    if (context.length === limit) break;
  }
  return context;
}

function normalize(vector: readonly number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(length) || length === 0) throw new Error("Invalid memory embedding.");
  return vector.map((value) => value / length);
}

function encode(vector: readonly number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  normalize(vector).forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function similarity(query: readonly number[], vector: Buffer): number {
  if (vector.length !== query.length * 4) return -1;
  return query.reduce((sum, value, index) => sum + value * vector.readFloatLE(index * 4), 0);
}

export function createMemoryRetriever(
  store: MemoryVectorStore,
  embedder: MemoryEmbedder,
  { minSimilarity = 0.42, contextMessages = 4 }: { minSimilarity?: number; contextMessages?: 2 | 4 } = {},
): MemoryRetriever {
  const pending = new Map<string, Promise<void>>();

  async function indexMissing(userId: string): Promise<void> {
    const missing = store.getMemoryCandidates(userId, embedder.id).filter(({ vector }) => !vector);
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const batch = missing.slice(offset, offset + batchSize);
      const vectors = await embedder.embed(batch.map(({ key, fact }) => `${key.replaceAll("_", " ")}: ${fact}`), "fact");
      if (vectors.length !== batch.length) throw new Error("Missing memory embeddings.");
      store.saveMemoryVectors(userId, embedder.id, batch.map(({ id }, i) => ({ id, vector: encode(vectors[i]!) })));
    }
  }

  function index(userId: string): Promise<void> {
    const existing = pending.get(userId);
    if (existing) return existing;
    const work = indexMissing(userId).finally(() => pending.delete(userId));
    pending.set(userId, work);
    return work;
  }

  return {
    index,
    async retrieve(userId, previous, utterances, signal) {
      signal?.throwIfAborted();
      if (!store.getMemoryCandidates(userId, embedder.id).length) return [];

      const current = utterances.join("\n");
      const context = recentText(previous, contextMessages);
      const queries = [current];
      if (context.length) queries.push(`Recent conversation:\n${context.join("\n")}\nCurrent user message:\n${current}`);

      const indexWait = new AbortController();
      const waitSignal = signal ? AbortSignal.any([signal, indexWait.signal]) : indexWait.signal;
      let query: number[];
      let contextualQuery: number[] | undefined;
      try {
        const [vectors] = await Promise.all([
          embedder.embed(queries, "query", signal),
          Promise.race([
            index(userId).catch(() => console.warn("Sara memory indexing failed.")),
            wait(indexWaitMs, undefined, { signal: waitSignal, ref: false }),
          ]),
        ]);
        if (vectors.length !== queries.length) throw new Error("Missing memory query embeddings.");
        query = normalize(vectors[0]!);
        contextualQuery = vectors[1] && normalize(vectors[1]);
      } catch {
        signal?.throwIfAborted();
        console.warn("Sara memory retrieval failed.");
        return [];
      } finally {
        indexWait.abort();
      }

      signal?.throwIfAborted();
      // Blend the context signal with the current message to limit earlier-topic matches.
      return store.getMemoryCandidates(userId, embedder.id).flatMap(({ key, fact, category, vector }) => {
        if (!vector) return [];
        const direct = similarity(query, vector);
        const contextual = contextualQuery ? similarity(contextualQuery, vector) : direct;
        const score = Math.max(direct, 0.45 * direct + 0.55 * contextual);
        return score >= minSimilarity ? [{ score, memory: { key, fact, category } }] : [];
      }).sort((a, b) => b.score - a.score).slice(0, maxResults).map(({ memory }) => memory);
    },
  };
}
