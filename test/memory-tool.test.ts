import { expect, test } from "vitest";
import { openDatabase } from "../src/db.js";
import { createMemoryTool } from "../src/tools/memoryTool.js";

test("reports a missing forget key while redacting history and blocking pending extraction", async () => {
  const database = openDatabase(":memory:");
  const userId = "memory-tool-test";
  const save = (content: string, id: string) => database.saveUserMessage({
    userId, channel: "text", content, clientMessageId: id, generationId: id,
  }).message.id;

  try {
    const savedId = save("My shop is called Loom&Leaf.", "saved");
    const savedFact = { key: "shop_name", fact: "The user's shop is named Loom&Leaf.", category: "business" };
    expect(database.applyMemoryChanges({
      userId, sourceMessageId: savedId, origin: "extracted", operations: [{ action: "add", ...savedFact }],
    })).toBe(true);

    const pendingId = save("मेरी दुकान दिल्ली में है।", "pending");
    const forgetId = save("मेरी दुकान की जगह भूल जाओ।", "forget");
    const result = await createMemoryTool(database, userId, forgetId).execute({
      action: "forget", key: "shop_city", fact: null, category: null, historyTerms: ["दिल्ली"],
    }, { toolCallId: "forget", messages: [] });

    expect(result).toMatch(/^No active saved fact matched that key\./);
    expect(database.applyMemoryChanges({
      userId,
      sourceMessageId: pendingId,
      origin: "extracted",
      operations: [{ action: "add", key: "shop_city", fact: "The user's shop is in दिल्ली.", category: "business" }],
    })).toBe(false);
    expect(database.getMemories(userId)).toEqual([savedFact]);
    expect(database.getModelHistory(userId)).toEqual([{ role: "user", content: "My shop is called Loom&Leaf." }]);
  } finally {
    database.close();
  }
});
