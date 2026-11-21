import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeLogger, tokenize, tts } from "@livekit/agents";
import { dispose } from "@livekit/rtc-node";
import { wrapLanguageModel } from "ai";
import { openDatabase, type Channel, type SaraDatabase } from "../src/db.js";
import { createModels } from "../src/engine/models.js";
import { createTurnEngine, type TurnEngine } from "../src/engine/turn.js";
import { createMemoryEmbedder } from "../src/memory/embeddings.js";
import type { MemoryFact } from "../src/memory/operations.js";
import { createMemoryRetriever } from "../src/memory/retrieval.js";
import { MacTTS } from "../src/voice/local-speech.js";

const baselineRef = process.env.SARA_BENCH_BASELINE ?? "66aed545d0351a5476d017ad101162540a9f7e28";
const repetitions = Number(process.env.SARA_BENCH_REPETITIONS ?? "3");
assert(Number.isInteger(repetitions) && repetitions > 0, "Set a positive integer for SARA_BENCH_REPETITIONS.");
const userId = "memory-experiment";
const useAudio = process.platform === "darwin" && process.env.SARA_BENCH_AUDIO !== "off";
const selectionOnly = process.env.SARA_BENCH_SELECTION_ONLY === "1";
const contextPair = process.env.SARA_BENCH_CONTEXT_PAIR === "1";
const thresholds = process.env.SARA_BENCH_THRESHOLDS?.split(",").map(Number) ?? [undefined];
if (useAudio && !selectionOnly) initializeLogger({ pretty: false, level: "warn" });

const targets: MemoryFact[] = [
  { key: "shop_city", fact: "The user's stationery shop is in Nashik.", category: "business" },
  { key: "shop_name", fact: "The user's stationery shop is named खोजBox.", category: "business" },
  { key: "shop_opening", fact: "The user's stationery shop opens at nine every morning.", category: "business" },
  { key: "shop_closing", fact: "The user's stationery shop closes at seven every evening.", category: "business" },
  { key: "shop_delivery", fact: "The user's stationery shop offers same-day delivery within two kilometres.", category: "business" },
  { key: "shop_product", fact: "The user's stationery shop sells accounting ledgers.", category: "business" },
  { key: "daughter_name", fact: "The user's daughter is named Anvi.", category: "family" },
  { key: "tea_preference", fact: "The user prefers lemongrass tea.", category: "preference" },
];
const distractors = [
  "goes swimming on Monday mornings",
  "keeps a mint plant by the kitchen window",
  "is saving up for a second-hand scooter",
  "replaces their bicycle tyres at the start of monsoon",
  "prefers cotton clothes in summer",
  "volunteers at a nearby animal shelter",
  "likes green mango pickle",
  "keeps spare keys in a blue bowl",
  "has breakfast with their cousin on Sundays",
  "reuses cardboard boxes for storage",
  "plays badminton after work",
  "listens to Hindustani classical music while cooking",
  "likes paper calendars with large print",
  "uses solar lights on their balcony",
  "does a weekly crossword with their brother",
  "buys fresh flowers every Friday",
  "lends old novels to friends",
  "takes the bus to the railway station",
  "saves their favourite recipes in a notebook",
  "keeps a first aid kit in the front hall",
  "enjoys watching cricket matches on weekend afternoons",
  "gives away old electronics through the community centre",
  "looks after a rescued dog",
  "drinks coconut water after exercise",
];
function factsFor(count: number): MemoryFact[] {
  const variants = ["regularly", "with friends", "when on leave", "at weekends"];
  return [
    ...targets,
    ...Array.from({ length: count - targets.length }, (_, index) => ({
      key: `other_detail_${index}`,
      fact: `The user ${distractors[index % distractors.length]} ${variants[Math.floor(index / distractors.length)]}.`,
      category: "other",
    })),
  ];
}

interface Scenario {
  name: string;
  channel: Channel;
  question: string;
  previous?: { user: string; assistant: string }[];
  expectedKey?: string;
  expectedAnswer?: RegExp;
  noMatch?: boolean;
}
const city = /\bNashik\b|\bNasik\b|नाशिक|नासिक/iu;
const scenarios: Scenario[] = [
  { name: "English voice", channel: "voice", question: "What city is my shop in?", expectedKey: "shop_city", expectedAnswer: city },
  { name: "Hindi voice", channel: "voice", question: "मेरी दुकान किस शहर में है?", expectedKey: "shop_city", expectedAnswer: city },
  { name: "Hinglish voice", channel: "voice", question: "Meri dukaan kaunsi city mein hai?", expectedKey: "shop_city", expectedAnswer: city },
  { name: "English chat", channel: "text", question: "Can you recall where my stationery store is based?", expectedKey: "shop_city", expectedAnswer: city },
  { name: "Hindi chat", channel: "text", question: "मेरी बेटी का नाम क्या है?", expectedKey: "daughter_name", expectedAnswer: /\bAnvi\b|अन्वी|अन्वि|आन्वी/iu },
  { name: "Hinglish chat", channel: "text", question: "Mujhe kaunsi chai pasand hai?", expectedKey: "tea_preference", expectedAnswer: /lemongrass|लेमन\s*ग्रास/iu },
  {
    name: "Context follow-up", channel: "text", question: "And what is it called?",
    previous: [{ user: "Can we talk about my stationery shop?", assistant: "Of course. What about your shop is on your mind?" }],
    expectedKey: "shop_name", expectedAnswer: /खोजBox|Khoj\s*Box/iu,
  },
  { name: "Unrelated English", channel: "text", question: "Why does the moon have phases?", noMatch: true },
  { name: "Unrelated Hindi", channel: "text", question: "सूर्य ग्रहण क्यों होता है?", noMatch: true },
  { name: "Unrelated Hinglish", channel: "text", question: "Rainbow mein kitne rang hote hain?", noMatch: true },
  {
    name: "Unrelated after shop context", channel: "text", question: "Why does the moon have phases?",
    previous: [{ user: "Can we talk about my stationery shop?", assistant: "Of course. What about your shop is on your mind?" }],
    noMatch: true,
  },
  { name: "Several shop details", channel: "text", question: "What do you remember about my shop's name, location, hours, products and delivery?" },
];

const contextScenarios: Scenario[] = [
  {
    name: "English voice follow-up", channel: "voice", question: "What was it called again?",
    previous: [
      { user: "I want to talk about my stationery shop.", assistant: "Sure, what do you want to know?" },
      { user: "I need to fill out a form.", assistant: "I can help you with that." },
    ],
    expectedKey: "shop_name", expectedAnswer: /खोजBox|Khoj\s*Box/iu,
  },
  {
    name: "Hindi voice follow-up", channel: "voice", question: "वह किस शहर में है?",
    previous: [
      { user: "मैं अपनी स्टेशनरी की दुकान के बारे में बात करना चाहती हूँ।", assistant: "ज़रूर, बताइए।" },
      { user: "मुझे यह फ़ॉर्म पूरा करना है।", assistant: "मैं मदद कर सकती हूँ।" },
    ],
    expectedKey: "shop_city", expectedAnswer: city,
  },
  {
    name: "Hinglish voice direct", channel: "voice", question: "Meri dukaan kaunsi city mein hai?",
    previous: [
      { user: "Mujhe thodi chai peeni hai.", assistant: "Haan, chai ka break achha rahega." },
      { user: "Ab meri dukaan ke liye ek form bharna hai.", assistant: "Chalo, form fill karte hain." },
    ],
    expectedKey: "shop_city", expectedAnswer: city,
  },
  {
    name: "Voice topic switch", channel: "voice", question: "Why does the moon have phases?",
    previous: [
      { user: "I want to talk about my stationery shop.", assistant: "Sure, what do you want to know?" },
      { user: "Let's switch to astronomy.", assistant: "Sure, go ahead." },
    ],
    noMatch: true,
  },
];

function contextFor(scenario: Scenario) {
  return (scenario.previous ?? []).flatMap(({ user, assistant }) => [
    { role: "user" as const, content: user },
    { role: "assistant" as const, content: assistant },
  ]);
}

function saveUser(database: SaraDatabase, channel: Channel, content: string) {
  return database.saveUserMessage({
    userId, channel, content, clientMessageId: randomUUID(), generationId: randomUUID(),
  });
}

function seed(database: SaraDatabase, facts: MemoryFact[]) {
  const { message } = saveUser(database, "text", "Synthetic benchmark fixtures.");
  assert(database.applyMemoryChanges({
    userId, sourceMessageId: message.id, origin: "extracted",
    operations: facts.map((fact) => ({ ...fact, action: "add" })),
  }));
  database.clearHistory(userId);
  assert.equal(database.getMemories(userId).length, facts.length);
}

function capturePrompt(chat: ReturnType<typeof createModels>["chat"]) {
  const prompt = { inputTokens: null as number | null, inputBytes: 0, stepCount: 0 };
  const model = wrapLanguageModel({
    model: chat,
    middleware: {
      specificationVersion: "v4",
      async wrapStream({ params, doStream }) {
        const first = prompt.stepCount++ === 0;
        if (first) prompt.inputBytes = Buffer.byteLength(JSON.stringify(params.prompt));
        const result = await doStream();
        if (!first) return result;
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream({
            transform(part, controller) {
              if (part.type === "finish") prompt.inputTokens = part.usage.inputTokens.total ?? null;
              controller.enqueue(part);
            },
          })),
        };
      },
    },
  });
  return { prompt, model };
}

async function runTurn(
  build: (model: ReturnType<typeof capturePrompt>["model"]) => TurnEngine,
  chat: ReturnType<typeof createModels>["chat"],
  database: SaraDatabase,
  scenario: Scenario,
  startAudio: boolean,
) {
  database.clearHistory(userId);
  const { channel, question, previous } = scenario;
  for (const { user, assistant } of previous ?? []) {
    const { generationId } = saveUser(database, channel, user);
    database.commitTurn({
      userId, channel, generationId, messages: [{ role: "assistant", content: assistant }],
    });
  }
  const { message } = saveUser(database, channel, question);
  const { prompt, model } = capturePrompt(chat);
  const engine = build(model);
  const audioAdapter = startAudio ? new tts.StreamAdapter(
    new MacTTS(), new tokenize.blingfire.SentenceTokenizer({ retainFormat: true }),
  ) : undefined;
  const stream = audioAdapter?.stream();
  const start = performance.now();
  const firstAudio = stream && (async () => {
    let firstVoicedMs: number | null = null;
    for await (const output of stream) {
      if (typeof output !== "symbol" && firstVoicedMs === null &&
          output.frame.data.some((sample) => Math.abs(sample) > 350)) {
        firstVoicedMs = Math.round(performance.now() - start);
      }
    }
    return firstVoicedMs;
  })();
  let answer = "";
  let firstTextMs: number | null = null;
  try {
    for await (const event of engine.run({
      userId, channel, utterances: [message], signal: AbortSignal.timeout(60_000),
    })) {
      if (event.type === "delta" && event.delta) {
        firstTextMs ??= Math.round(performance.now() - start);
        answer += event.delta;
        stream?.pushText(event.delta);
      }
    }
    stream?.endInput();
    const firstAudioMs = await firstAudio ?? null;
    if (startAudio) assert(firstAudioMs !== null, "macOS TTS did not produce a voiced PCM frame.");
    return {
      ...prompt, firstTextMs, firstAudioMs, answer,
      recall: scenario.expectedAnswer ? scenario.expectedAnswer.test(answer) : null,
    };
  } finally {
    stream?.close();
    await audioAdapter?.close();
  }
}

function measuredEngine(database: SaraDatabase, memory: ReturnType<typeof createMemoryRetriever>) {
  let retrieval: { keys: string[]; ms: number } | undefined;
  return {
    get retrieval() { return retrieval; },
    build: (model: ReturnType<typeof capturePrompt>["model"]) => createTurnEngine(database, {
      model, reasoning: "none",
      memory: {
        ...memory,
        async retrieve(...args: Parameters<typeof memory.retrieve>) {
          const start = performance.now();
          const facts = await memory.retrieve(...args);
          retrieval = { keys: facts.map(({ key }) => key), ms: Math.round(performance.now() - start) };
          return facts;
        },
      },
    }),
  };
}

async function runContextComparison(database: SaraDatabase) {
  const facts = factsFor(80);
  seed(database, facts);
  const models = createModels();
  const embedder = createMemoryEmbedder();
  const arms = ([2, 4] as const).map((contextMessages) => {
    const memory = createMemoryRetriever(database, embedder, { contextMessages });
    return { contextMessages, memory, engine: measuredEngine(database, memory) };
  });
  console.log(JSON.stringify({
    comparison: "two-vs-four-messages", provider: models.provider, chat: models.chat.modelId,
    embeddings: embedder.id, facts: facts.length, audio: useAudio && !selectionOnly ? "transcript-to-first-voiced-PCM" : "off",
    repetitions: selectionOnly ? 1 : repetitions,
  }));
  // Both arms use the same fact vectors and replay the same full dialogue to the reply model.
  await arms[0]!.memory.index(userId);
  if (!selectionOnly) {
    for (const arm of arms) await runTurn(arm.engine.build, models.chat, database, contextScenarios[0], useAudio);
  }
  for (const [index, scenario] of contextScenarios.entries()) {
    for (let attempt = 0; attempt < (selectionOnly ? 1 : repetitions); attempt++) {
      const order = (index + attempt) % 2 === 0 ? arms : [...arms].reverse();
      for (const { contextMessages, memory, engine } of order) {
        const result = selectionOnly
          ? { keys: (await memory.retrieve(userId, contextFor(scenario), [scenario.question])).map(({ key }) => key) }
          : { ...await runTurn(engine.build, models.chat, database, scenario, useAudio), retrieval: engine.retrieval };
        console.log(JSON.stringify({
          case: scenario.name, contextMessages, attempt: attempt + 1, ...result,
          expectedKey: scenario.expectedKey, noMatch: scenario.noMatch,
        }));
      }
    }
  }
}

async function runBaselineComparison(directory: string) {
  let baselineDb: SaraDatabase | undefined;
  let experimentDb: SaraDatabase | undefined;
  execFileSync("tar", ["-xf", "-", "-C", directory], {
    input: execFileSync("git", ["archive", baselineRef, "package.json", "src"]),
  });
  symlinkSync(realpathSync("node_modules"), join(directory, "node_modules"), "dir");
  const baselineDbModule = await import(pathToFileURL(join(directory, "src", "db.ts")).href) as typeof import("../src/db.js");
  const baselineEngineModule = await import(pathToFileURL(join(directory, "src", "engine", "turn.ts")).href) as typeof import("../src/engine/turn.js");
  const models = createModels();
  const embedder = createMemoryEmbedder();
  console.log(JSON.stringify({
    baseline: baselineRef, provider: models.provider, chat: models.chat.modelId,
    embeddings: embedder.id, audio: useAudio ? "transcript-to-first-voiced-PCM" : "off", repetitions,
  }));

  try {
    for (const count of [8, 80]) {
      const baseline = baselineDb = baselineDbModule.openDatabase(join(directory, `baseline-${count}.sqlite`));
      const experiment = experimentDb = openDatabase(join(directory, `experiment-${count}.sqlite`));
      const facts = factsFor(count);
      seed(baseline, facts);
      seed(experiment, facts);
      const memory = createMemoryRetriever(experiment, embedder);
      const indexingStart = performance.now();
      await memory.index(userId);
      console.log(JSON.stringify({ facts: count, indexMs: Math.round(performance.now() - indexingStart) }));
      const engine = measuredEngine(experiment, memory);
      const arms = [
        { name: "full", database: baseline, build: (model: ReturnType<typeof capturePrompt>["model"]) =>
          baselineEngineModule.createTurnEngine(baseline, { model, reasoning: "none" }) },
        { name: "similarity", database: experiment, build: engine.build },
      ];
      const cases = count === 8 ? scenarios.slice(0, 3) : scenarios;
      if (selectionOnly) {
        for (const minSimilarity of thresholds) {
          const trial = minSimilarity === undefined ? memory : createMemoryRetriever(experiment, embedder, { minSimilarity });
          for (const scenario of cases) {
            const facts = await trial.retrieve(userId, contextFor(scenario), [scenario.question]);
            console.log(JSON.stringify({
              facts: count, minSimilarity, case: scenario.name, keys: facts.map(({ key }) => key),
              expectedKey: scenario.expectedKey, noMatch: scenario.noMatch,
            }));
          }
        }
        baselineDb.close();
        baselineDb = undefined;
        experimentDb.close();
        experimentDb = undefined;
        continue;
      }
      for (const arm of arms) {
        await runTurn(arm.build, models.chat, arm.database, scenarios[0], useAudio);
      }
      for (const [index, scenario] of cases.entries()) {
        const attempts = scenario.channel === "voice" ? repetitions : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
          const order = (index + attempt) % 2 === 0 ? arms : [...arms].reverse();
          for (const arm of order) {
            const result = await runTurn(arm.build, models.chat, arm.database, scenario, useAudio && scenario.channel === "voice");
            console.log(JSON.stringify({
              facts: count, case: scenario.name, attempt: attempt + 1, arm: arm.name, ...result,
              retrieval: arm.name === "similarity" ? engine.retrieval : undefined,
              expectedKey: scenario.expectedKey, noMatch: scenario.noMatch,
            }));
          }
        }
      }
      baselineDb.close();
      baselineDb = undefined;
      experimentDb.close();
      experimentDb = undefined;
    }
  } finally {
    baselineDb?.close();
    experimentDb?.close();
  }
}

const directory = mkdtempSync(join(tmpdir(), "sara-memory-experiment-"));
try {
  if (contextPair) {
    const database = openDatabase(join(directory, "context.sqlite"));
    try {
      await runContextComparison(database);
    } finally {
      database.close();
    }
  } else {
    await runBaselineComparison(directory);
  }
} finally {
  await dispose();
  rmSync(directory, { recursive: true, force: true });
}
