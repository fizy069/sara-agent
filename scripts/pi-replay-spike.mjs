import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { openDatabase } from "../src/db.ts";
import { createTurnEngine } from "../src/engine/turn.ts";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY in .env to run the Terra replay spike.");

const tool = {
  name: "get_demo_code",
  label: "Get demo code",
  description: "Returns the requested code for a chat harness demo.",
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() {
    return { content: [{ type: "text", text: "checkpoint-code" }], details: null };
  },
};

const userId = "pi-replay";
const channel = "text";

async function send(database, content) {
  const engine = createTurnEngine(database, {
    modelId: "gpt-6.1-terra",
    reasoning: "low",
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
    tools: [tool],
    maxTokens: 600,
  });
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
  throw new Error("The replay spike got no completed turn.");
}

const directory = mkdtempSync(join(tmpdir(), "sara-replay-"));
const path = join(directory, "spike.sqlite");
let database = openDatabase(path);
try {
  const first = await send(database, "Use the get_demo_code tool now, then tell me the code it returns.");
  const call = first[0]?.content.find((part) => part.type === "toolCall");
  const carriesEncryptedReasoning = first[0]?.content.some((part) => {
    if (part.type !== "thinking" || !part.thinkingSignature) return false;
    const { encrypted_content } = JSON.parse(part.thinkingSignature);
    return typeof encrypted_content === "string" && encrypted_content.length > 0;
  });
  assert(call && carriesEncryptedReasoning, "Expected a tool call and an encrypted reasoning item from Terra.");
  assert.equal(first.find((message) => message.role === "toolResult")?.toolCallId, call.id);

  database.close();
  database = openDatabase(path);
  assert.deepEqual(database.getModelHistory(userId).slice(1), JSON.parse(JSON.stringify(first)));
  const replay = await send(database, "Based on our conversation, what code did the tool return?");
  const removedReasoning = [...first, ...replay].some(
    (message) => message.diagnostics?.some(({ type }) => type === "openai_input_transformations"),
  );
  assert(!removedReasoning, "OpenAI reported removing replayed reasoning.");
  console.log("Terra replay accepted after reopening SQLite. Tool IDs and encrypted reasoning survived serialization.");
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
