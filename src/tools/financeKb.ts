import { existsSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { embedFinanceQuery } from "../finance/embeddings.js";
import { defaultFinanceIndexPath, nearestFinanceDocument } from "../finance/vectorStore.js";

const minimumSimilarity = 0.45;

export function createLookupFinance(
  indexPath = process.env.SARA_FINANCE_DB_PATH ?? defaultFinanceIndexPath,
  embedQuery = embedFinanceQuery,
) {
  return tool({
    description: "Find a source document about Indian small-business and personal finance. Always translate the user's question into a short, specific English query, even when they speak Hindi or Hinglish. Keep scheme names and acronyms. A similar document can still lack the exact fact requested.",
    inputSchema: z.strictObject({
      query: z.string().trim().min(1).max(300).describe("A short English question or phrase. Translate non-English wording before searching."),
    }),
    async execute({ query }, { abortSignal }) {
      abortSignal?.throwIfAborted();
      if (!existsSync(indexPath)) return { status: "unavailable", matches: [] };

      try {
        const timeout = AbortSignal.timeout(10_000);
        const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
        const embedding = await embedQuery(query, signal);
        const nearest = nearestFinanceDocument(indexPath, embedding);
        if (!nearest || 1 - nearest.distance < minimumSimilarity) return { status: "no_match", matches: [] };
        const { distance: _, ...document } = nearest;
        return { status: "match", matches: [document] };
      } catch {
        abortSignal?.throwIfAborted();
        return { status: "unavailable", matches: [] };
      }
    },
  });
}

export const lookupFinance = createLookupFinance();
