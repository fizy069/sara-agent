import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, wrapLanguageModel } from "ai";
import { z } from "zod";
import { openDatabase, type SaraDatabase } from "../src/db.js";
import { assistantText } from "../src/engine/messages.js";
import { createModels } from "../src/engine/models.js";
import { createTurnEngine } from "../src/engine/turn.js";

const code = `checkpoint-${randomUUID().slice(0, 8)}`;
let toolCalls = 0;
const models = createModels();
const model = wrapLanguageModel({
  model: models.chat,
  middleware: {
    specificationVersion: "v4",
    async transformParams({ params }) {
      return toolCalls === 0
        ? { ...params, toolChoice: { type: "tool", toolName: "get_demo_code" } }
        : params;
    },
  },
});
const tools = {
  get_demo_code: tool({
    description: "Return the checkpoint code for this replay check.",
    inputSchema: z.object({}),
    async execute() {
      toolCalls += 1;
      return code;
    },
  }),
};

const userId = "replay-check";
const channel = "text";

async function send(database: SaraDatabase, content: string) {
  const engine = createTurnEngine(database, { model, reasoning: "none", tools });
  const generationId = randomUUID();
  const { message } = database.saveUserMessage({
    userId, channel, content, clientMessageId: randomUUID(), generationId,
  });

  for await (const event of engine.run({
    userId, channel, utterances: [message], signal: AbortSignal.timeout(45_000),
  })) {
    if (event.type === "complete") {
      database.commitTurn({ userId, channel, generationId, messages: event.messages });
      return event.messages;
    }
  }
  throw new Error("The replay check received no completed turn.");
}

const directory = mkdtempSync(join(tmpdir(), "sara-replay-"));
const path = join(directory, "replay.sqlite");
let database: SaraDatabase | undefined;
try {
  database = openDatabase(path);
  const first = await send(database, "Call get_demo_code exactly once. Then say you have the code without revealing it.");
  assert.equal(toolCalls, 1, "Expected the first turn to call get_demo_code once.");
  assert.deepEqual(first.map(({ role }) => role), ["assistant", "tool", "assistant"]);
  assert(!assistantText(first).includes(code), "Expected the code to appear only in the tool result.");

  database.close();
  database = undefined;
  database = openDatabase(path);
  assert.deepEqual(database.getModelHistory(userId).slice(1), first);

  const replay = await send(database, "What exact code did get_demo_code return in the previous turn? Answer from history without calling it again.");
  assert.equal(toolCalls, 1, "Expected the follow-up to use the stored result without another tool call.");
  assert(assistantText(replay).includes(code), "Expected the reply to contain the earlier tool result.");
  console.log(`${models.provider} (${model.modelId}) used the stored tool result after reopening SQLite.`);
} finally {
  database?.close();
  rmSync(directory, { recursive: true, force: true });
}
