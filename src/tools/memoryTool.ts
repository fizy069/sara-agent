import type { AgentTool } from "@earendil-works/pi-agent-core";
import Type from "typebox";
import { memoryOperationSchema } from "../memory/operations.js";
import type { MemoryStore } from "../memory/store.js";

const parameters = Type.Object({
  action: Type.Union([Type.Literal("forget"), Type.Literal("correct")]),
  key: Type.String({ description: "Reuse the saved fact's key where possible. Use snake_case." }),
  fact: Type.Optional(Type.String({ description: "The replacement fact for a correction." })),
  category: Type.Optional(Type.String({ description: "A short category for the corrected fact." })),
  historyTerms: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: 12,
    description: "For a forget, include distinctive names, values or phrases that identify the fact in prior messages.",
  })),
}, { additionalProperties: false });

export function createMemoryTool(store: MemoryStore, userId: string, sourceMessageId: string): AgentTool<typeof parameters> {
  return {
    name: "forget_or_correct_memory",
    label: "Forget or correct memory",
    description: "Use when the user asks you to forget a fact or explicitly corrects something about themselves. Call once for each affected key.",
    parameters,
    executionMode: "sequential",
    async execute(_id, { action, key, fact, category, historyTerms }, signal) {
      signal?.throwIfAborted();
      const operation = memoryOperationSchema.parse(action === "forget"
        ? { action: "delete", key }
        : { action: "update", key, fact, category });
      const applied = store.applyMemoryChanges({
        userId, sourceMessageId, origin: "explicit", operations: [{ ...operation, historyTerms }],
      });
      if (!applied) throw new Error("The memory change could not be applied to this message.");
      return {
        content: [{ type: "text", text: action === "forget" ? "Fact forgotten." : "Correction saved." }],
        details: null,
      };
    },
  };
}
