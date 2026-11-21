import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { expect, test, vi } from "vitest";
import { openDatabase, type SaraDatabase } from "../src/db.js";
import type { MemoryOperation } from "../src/memory/operations.js";
import { createMemoryRetriever } from "../src/memory/retrieval.js";

function apply(database: SaraDatabase, userId: string, ...operations: MemoryOperation[]) {
  const clientMessageId = crypto.randomUUID();
  const { message } = database.saveUserMessage({
    userId, clientMessageId, generationId: clientMessageId, channel: "text", content: "A durable fact.",
  });
  database.applyMemoryChanges({ userId, sourceMessageId: message.id, origin: "explicit", operations });
}

function fact(key: string, value: string): MemoryOperation {
  return { action: "update", key, fact: value, category: "test" };
}

test("only selects matching facts for this user and caps the result at five", async () => {
  using database = disposableDatabase();
  for (const userId of ["one", "two"]) {
    apply(database.value, userId, ...Array.from({ length: 7 }, (_, i) => fact(`shop_${i}`, `${userId} shop ${i}`)));
    apply(database.value, userId, fact("pet", "A dog"));
  }
  const embed = vi.fn(async (texts: readonly string[]) => texts.map((text) =>
    text.startsWith("shop") || text === "Do I own a business?" ? [1, 0, 0] :
      text.startsWith("pet") ? [0, 1, 0] : [0, 0, 1]));
  const memory = createMemoryRetriever(database.value, { id: "test", embed });

  const results = await memory.retrieve("one", [], ["Do I own a business?"]);
  expect(results).toHaveLength(5);
  expect(results.every(({ fact }) => fact.startsWith("one shop"))).toBe(true);
  expect(embed.mock.calls.flatMap(([texts]) => texts).some((text) => text.includes("two shop"))).toBe(false);
  await expect(memory.retrieve("one", [], ["What is the weather?"])).resolves.toEqual([]);
});

test("uses up to four previous messages to resolve an incomplete question", async () => {
  using database = disposableDatabase();
  apply(database.value, "one", fact("shop_name", "Owns a shop called Saffron."));
  const embedder = {
    id: "test",
    async embed(texts: readonly string[], kind: "fact" | "query") {
      return texts.map((text) => kind === "fact" || (text.includes("assume I mean my shop") && !text.includes("Prior topic"))
        ? [1, 0] : [0, 1]);
    },
  };
  const memory = createMemoryRetriever(database.value, embedder);
  const twoMessages = createMemoryRetriever(database.value, embedder, { contextMessages: 2 });
  const question = ["और उसका नाम?"];
  const history: ModelMessage[] = [
    { role: "assistant", content: "Prior topic." },
    { role: "user", content: "If I say it, assume I mean my shop." },
    { role: "assistant", content: "Understood." },
    { role: "user", content: "Can I ask a question?" },
    { role: "assistant", content: "Of course." },
  ];
  await expect(memory.retrieve("one", [], question)).resolves.toEqual([]);
  await expect(twoMessages.retrieve("one", history, question)).resolves.toEqual([]);
  await expect(memory.retrieve("one", history, question)).resolves.toMatchObject([{ key: "shop_name" }]);
});

test("persists vectors and never recalls superseded or forgotten values", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sara-retrieval-"));
  const path = join(directory, "sara.sqlite");
  let database = openDatabase(path);
  const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
  const embedder = { id: "test", embed };
  try {
    apply(database, "one", fact("shop_city", "Shop is in Pune."));
    await createMemoryRetriever(database, embedder).index("one");
    database.close();
    database = openDatabase(path);
    const memory = createMemoryRetriever(database, embedder);
    embed.mockClear();
    await expect(memory.retrieve("one", [], ["Where is my shop?"])).resolves.toMatchObject([{ fact: "Shop is in Pune." }]);
    expect(embed.mock.calls.map(([texts]) => texts)).toEqual([["Where is my shop?"]]);

    apply(database, "one", fact("shop_city", "Shop is in Surat."));
    await expect(memory.retrieve("one", [], ["Where is my shop?"])).resolves.toMatchObject([{ fact: "Shop is in Surat." }]);
    apply(database, "one", { action: "delete", key: "shop_city" });
    await expect(memory.retrieve("one", [], ["Where is my shop?"])).resolves.toEqual([]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not attach a stale embedding to a fact replaced during indexing", async () => {
  using database = disposableDatabase();
  const indexed = Promise.withResolvers<number[][]>();
  const memory = createMemoryRetriever(database.value, {
    id: "test",
    embed: () => indexed.promise,
  });
  apply(database.value, "one", fact("shop_city", "Shop is in Pune."));
  const indexing = memory.index("one");
  apply(database.value, "one", fact("shop_city", "Shop is in Surat."));
  indexed.resolve([[1, 0]]);
  await indexing;

  expect(database.value.getMemoryCandidates("one", "test")).toMatchObject([
    { fact: "Shop is in Surat.", vector: null },
  ]);
});

function disposableDatabase() {
  const value = openDatabase(":memory:");
  return { value, [Symbol.dispose]: () => value.close() };
}
