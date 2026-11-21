import { tool } from "ai";
import { z } from "zod";
import { memoryOperationSchema } from "../memory/operations.js";
import type { MemoryStore } from "../memory/store.js";

const inputSchema = z.strictObject({
  action: z.enum(["forget", "correct"]),
  key: z.string().describe("Reuse the saved fact's key where possible. Use snake_case."),
  fact: z.string().nullable().describe("The replacement fact for a correction, or null when forgetting."),
  category: z.string().nullable().describe("A short category for the corrected fact, or null when forgetting."),
  historyTerms: z.array(z.string().min(1).max(200)).max(12).nullable().describe(
    "For a forget, include distinctive names, values or phrases that identify the fact in prior messages. Use null if unavailable.",
  ),
});

export function createMemoryTool(store: MemoryStore, userId: string, sourceMessageId: string) {
  return tool({
    description: "Use when the user asks you to forget a fact or explicitly corrects something about themselves. Call once for each affected key.",
    inputSchema,
    async execute({ action, key, fact, category, historyTerms }, { abortSignal }) {
      abortSignal?.throwIfAborted();
      const operation = memoryOperationSchema.parse(action === "forget"
        ? { action: "delete", key }
        : { action: "update", key, fact, category });
      const applied = store.applyMemoryChanges({
        userId, sourceMessageId, origin: "explicit", operations: [{ ...operation, historyTerms: historyTerms ?? undefined }],
      });
      if (!applied) throw new Error("The memory change could not be applied to this message.");
      return action === "forget" ? "Fact forgotten." : "Correction saved.";
    },
  });
}
