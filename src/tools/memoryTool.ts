import { tool } from "ai";
import { z } from "zod";
import { memoryFactWriting, memoryOperationSchema } from "../memory/operations.js";
import type { MemoryStore } from "../memory/store.js";

const inputSchema = z.strictObject({
  action: z.enum(["forget", "correct"]),
  key: z.string().describe("Use the saved fact's exact snake_case key when changing an existing fact, in any language."),
  fact: z.string().nullable().describe(`The full replacement fact for a correction, or null when forgetting. ${memoryFactWriting}`),
  category: z.string().nullable().describe("A short English category for the corrected fact, or null when forgetting."),
  historyTerms: z.array(z.string().min(1).max(200)).max(12).nullable().describe(
    "For a forget, include distinctive names, values or phrases that identify the fact in prior messages. Copy them in the language and script used in those messages. Use null if unavailable.",
  ),
});

export function createMemoryTool(store: MemoryStore, userId: string, sourceMessageId: string) {
  return tool({
    description: `Use when the user asks you to forget a fact or explicitly corrects something about themselves. Call once for each affected key. For corrections, ${memoryFactWriting} For example, if the user names their shop गुलमोहर, store "The user's shop is named गुलमोहर."`,
    inputSchema,
    async execute({ action, key, fact, category, historyTerms }, { abortSignal }) {
      abortSignal?.throwIfAborted();
      const operation = memoryOperationSchema.parse(action === "forget"
        ? { action: "delete", key }
        : { action: "update", key, fact, category });
      const matched = action === "forget" && store.getMemories(userId).some((memory) => memory.key === key);
      const applied = store.applyMemoryChanges({
        userId, sourceMessageId, origin: "explicit", operations: [{ ...operation, historyTerms: historyTerms ?? undefined }],
      });
      if (!applied) throw new Error("The memory change could not be applied to this message.");
      if (action === "correct") return "Correction saved.";
      if (!matched) return "No active saved fact matched that key. Do not claim a saved fact was removed. Ask for clarification if the intended detail is unclear.";
      return "Fact forgotten. Confirm briefly in the user's language without repeating the detail. For example, say 'I've forgotten that.'";
    },
  });
}
