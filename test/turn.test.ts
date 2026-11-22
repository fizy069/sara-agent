import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openDatabase, type SaraDatabase } from "../src/db.js";
import { createTurnEngine, type TurnEvent } from "../src/engine/turn.js";

type MockStreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type MockStreamPart = MockStreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const userId = "turn-test";
const generationId = "generation";
const channel = "text";
const content = "What is the monthly EMI for ₹5 lakh at 12% over 36 months?";

let directory: string;
let databasePath: string;
let database: SaraDatabase;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sara-turn-"));
  databasePath = join(directory, "sara.sqlite");
  database = openDatabase(databasePath);
});

afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function finish(unified: "stop" | "tool-calls"): MockStreamPart {
  return {
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    },
  };
}

function stream(...parts: MockStreamPart[]): MockStreamResult {
  return { stream: convertArrayToReadableStream(parts) };
}

function reply(...deltas: string[]): MockStreamResult {
  const id = "reply";
  return stream(
    { type: "text-start", id },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id, delta })),
    { type: "text-end", id, providerMetadata: { openai: { itemId: "provider-only" } } },
    finish("stop"),
  );
}

function emiStep(toolCallId: string): MockStreamResult {
  return stream({
    type: "tool-call",
    toolName: "calculate_emi",
    toolCallId,
    input: JSON.stringify({ principal: 500_000, annualRatePct: 12, tenureMonths: 36 }),
  }, finish("tool-calls"));
}

function run(model: MockLanguageModelV4, signal = new AbortController().signal) {
  const { message } = database.saveUserMessage({ userId, generationId, channel, content, clientMessageId: "user" });
  const engine = createTurnEngine(database, { model, reasoning: "none" });
  return engine.run({ userId, channel, utterances: [message], signal });
}

async function collect(stream: AsyncIterable<TurnEvent>, onEvent?: (event: TurnEvent) => void) {
  const events: TurnEvent[] = [];
  for await (const event of stream) {
    onEvent?.(event);
    events.push(event);
  }
  return events;
}

test("streams plain text in order and completes with provider-neutral history", async () => {
  const model = new MockLanguageModelV4({ doStream: reply("Hello", " there.") });

  await expect(collect(run(model))).resolves.toEqual([
    { type: "delta", delta: "Hello" },
    { type: "delta", delta: " there." },
    { type: "complete", messages: [{ role: "assistant", content: [{ type: "text", text: "Hello there." }] }] },
  ]);
});

test("replays more than twelve short messages and drops the entire exchange at the token boundary", async () => {
  const olderGeneration = "older-generation";
  database.saveUserMessage({
    userId, channel, generationId: olderGeneration, clientMessageId: "older", content: "पुराना संदेश। ".repeat(200),
  });
  database.commitTurn({
    userId, channel, generationId: olderGeneration, messages: [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "old", toolName: "calculate_emi", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "calculate_emi", output: { type: "text", value: "Old result" } }] },
      { role: "assistant", content: "Old reply" },
    ],
  });
  const recent = Array.from({ length: 7 }, (_, index) => `recent-${index}`);
  for (const id of recent) {
    database.saveUserMessage({ userId, channel, generationId: id, clientMessageId: id, content: `Message ${id}` });
    database.commitTurn({ userId, channel, generationId: id, messages: [{ role: "assistant", content: `Reply ${id}` }] });
  }

  const model = new MockLanguageModelV4({ doStream: reply("Hello.") });
  await collect(run(model));

  const prompt = model.doStreamCalls[0].prompt.filter(({ role }) => role !== "system");
  expect(prompt).toEqual([
    ...recent.flatMap((id) => [
      { role: "user", content: [{ type: "text", text: `Message ${id}` }] },
      { role: "assistant", content: [{ type: "text", text: `Reply ${id}` }] },
    ]),
    { role: "user", content: [{ type: "text", text: content }] },
  ]);
});

test("sends the current message even when it uses the whole conversation budget", async () => {
  database.saveUserMessage({ userId, channel, generationId: "prior", clientMessageId: "prior", content: "Hi" });
  const { message } = database.saveUserMessage({ userId, channel, generationId, clientMessageId: "user", content });
  const model = new MockLanguageModelV4({ doStream: reply("Hello.") });
  const engine = createTurnEngine(database, { model, reasoning: "none", contextWindow: 64 });

  await collect(engine.run({ userId, channel, utterances: [message], signal: new AbortController().signal }));

  expect(model.doStreamCalls[0].prompt.filter(({ role }) => role !== "system")).toEqual([
    { role: "user", content: [{ type: "text", text: content }] },
  ]);
});

test("executes the EMI tool and preserves the full exchange across a SQLite reopen", async () => {
  const model = new MockLanguageModelV4({ doStream: [emiStep("emi"), reply("Your EMI is ₹16,607.15.")] });
  const events = await collect(run(model));
  expect(events.slice(0, 2)).toEqual([
    { type: "tool", name: "calculate_emi", phase: "start" },
    { type: "tool", name: "calculate_emi", phase: "end" },
  ]);
  const final = events.at(-1);
  expect(final?.type).toBe("complete");
  if (final?.type !== "complete") throw new Error("Expected a completed turn.");
  expect(final.messages.map(({ role }) => role)).toEqual(["assistant", "tool", "assistant"]);
  expect(final.messages[1]).toMatchObject({
    content: [{ type: "tool-result", output: { type: "text", value: "Monthly EMI: ₹16607.15." } }],
  });

  database.commitTurn({ userId, generationId, channel, messages: final.messages });
  database.close();
  database = openDatabase(databasePath);

  expect(database.getModelHistory(userId)).toEqual([{ role: "user", content }, ...final.messages]);
});

test("aborts during a streamed step without completing", async () => {
  const controller = new AbortController();
  const model = new MockLanguageModelV4({ doStream: reply("First", " second.") });

  await expect(collect(run(model, controller.signal), (event) => {
    expect(event.type).toBe("delta");
    controller.abort();
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(database.getModelHistory(userId)).toEqual([{ role: "user", content }]);
});

test("propagates a provider error from the stream", async () => {
  const error = new Error("Mock provider failed.");
  const model = new MockLanguageModelV4({ doStream: stream({ type: "error", error }) });

  await expect(collect(run(model))).rejects.toBe(error);
});

test("fails when the fourth step still calls a tool", async () => {
  const model = new MockLanguageModelV4({ doStream: [1, 2, 3, 4].map((step) => emiStep(`emi-${step}`)) });

  await expect(collect(run(model))).rejects.toThrow("Model turn failed (tool-calls).");
  expect(model.doStreamCalls).toHaveLength(4);
});
