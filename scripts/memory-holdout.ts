import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import { openDatabase } from "../src/db.js";
import { createMemoryEmbedder } from "../src/memory/embeddings.js";
import { createMemoryRetriever } from "../src/memory/retrieval.js";

const facts = {
  shop_name: "The user's shop is called Kaveri Tailoring Studio.",
  shop_city: "The user's shop is in Jaipur.",
  shop_hours: "The user's tailoring shop closes at 7 p.m.",
  payment: "The user prefers to receive payments by UPI.",
  supplier: "The user's main fabric supplier is Noor Collection.",
  new_branch: "The user plans to open a second branch in Ajmer.",
  employees: "The user has hired Afsana and Kavita as employees.",
  sister_name: "The user's sister is named नूरजहाँ.",
  brother_name: "The user's brother is named Armaan.",
  favorite_sweet: "The user's favorite dessert is coconut barfi.",
  vehicle: "The user owns a silver Maruti Swift.",
  lunch: "The user usually eats lunch at 1 p.m.",
  family_city: "The user's parents live in Udaipur.",
  accounting: "The user prefers Zoho Books for accounting.",
  bank: "The user has a business bank account with Union Bank.",
  sport: "The user is a fan of badminton.",
  service: "The user's shop specializes in altering salwar kameez.",
  holiday: "The user takes Mondays off.",
};

type History = [user: string, assistant: string] | [firstUser: string, firstAssistant: string, lastUser: string, lastAssistant: string];
type Question = [text: string, expectedKey?: keyof typeof facts, previous?: History];

const questions: Record<string, Question[]> = {
  English: [
    ["What name did I give you for my store?", "shop_name"],
    ["Which city is my business located in?", "shop_city"],
    ["What is my preferred payment method?", "payment"],
    ["I want to restock. Who was my fabric vendor again?", "supplier"],
    ["What's my sister's name?", "sister_name"],
    ["What was her name again?", "sister_name", ["I want to invite my sister over.", "Sure."]],
    ["Good morning!"],
    ["What makes the sky blue?"],
    ["What is the meaning of APR?"],
    ["Tell me three tips to improve productivity."],
  ],
  Hindi: [
    ["मैंने अपनी दुकान का क्या नाम बताया था?", "shop_name"],
    ["मेरी दुकान किस शहर में है?", "shop_city"],
    ["मुझे पैसे किस तरीके से लेना पसंद है?", "payment"],
    ["मुझे कपड़े का माल कौन बेचता है, याद है?", "supplier"],
    ["मेरी बहन का नाम क्या है?", "sister_name"],
    ["उनका नाम क्या था?", "sister_name", ["मैं अपनी बहन को बुलाना चाहती हूँ।", "बिल्कुल।"]],
    ["जी, शुक्रिया।"],
    ["कल बारिश होगी क्या?"],
  ],
  Hinglish: [
    ["Meri dukaan ka kya naam bataya tha maine?", "shop_name"],
    ["Meri shop kis shehar mein hai?", "shop_city"],
    ["Paise receive karne ke liye kya prefer karti hoon?", "payment"],
    ["Kapde ka maal lene ke liye main kise contact karun?", "supplier"],
    ["Meri behen ka naam kya hai?", "sister_name"],
    ["Uska naam kya tha?", "sister_name", ["Mujhe apni behen ko bulana hai.", "Bilkul."]],
    ["Thanks Sara, theek hai."],
    ["Yeh batao, samundar itna khara kyu hai?"],
    ["Invoice ka GST rate kaise nikalun?"],
  ],
};

const longContextQuestions: Record<string, Question[]> = {
  English: [
    ["What was her name again?", "sister_name", ["I want to invite my sister over.", "Sure.", "I'll put her on the list.", "Good idea."]],
    ["What was it called?", "shop_name", ["I'd like to make a sign for my tailoring shop.", "Let's work on it.", "Can you remind me of one detail first?", "Of course."]],
    ["What was her name?", "sister_name", ["Can we talk about my shop name?", "Sure.", "Actually, let's talk about my sister.", "Of course."]],
    ["What makes the sky blue?", undefined, ["Can we talk about my stationery shop?", "Sure.", "I'd like to change the subject.", "Go ahead."]],
    ["What is the capital of Portugal?", undefined, ["Let's talk about the city my shop is in.", "Sure.", "First, a geography question.", "Ask away."]],
  ],
  Hindi: [
    ["उनका नाम क्या था?", "sister_name", ["मैं अपनी बहन को बुलाना चाहती हूँ।", "बिल्कुल।", "मैं उन्हें सूची में डाल दूँगी।", "ठीक है।"]],
    ["उसका नाम क्या था?", "shop_name", ["मैं अपनी सिलाई की दुकान के लिए बोर्ड बनवाना चाहती हूँ।", "ज़रूर।", "पहले एक बात याद दिलाओगी?", "बिल्कुल।"]],
    ["उनका नाम क्या है?", "sister_name", ["मेरी दुकान के नाम की बात करें?", "ज़रूर।", "मैं अपनी बहन के बारे में बात करना चाहती हूँ।", "बिल्कुल।"]],
    ["सूर्य ग्रहण क्यों होता है?", undefined, ["मेरी दुकान के बारे में बात करें?", "ज़रूर।", "पहले एक अलग सवाल है।", "पूछो।"]],
    ["पुर्तगाल की राजधानी क्या है?", undefined, ["मुझे अपनी दुकान के शहर की बात करनी है।", "ज़रूर।", "पहले भूगोल का एक सवाल है।", "पूछो।"]],
  ],
  Hinglish: [
    ["Uska naam kya tha?", "sister_name", ["Mujhe apni behen ko bulana hai.", "Bilkul.", "Main usko list mein daal dungi.", "Theek hai."]],
    ["Uska naam kya tha?", "shop_name", ["Mujhe apni tailoring shop ka sign banwana hai.", "Bilkul.", "Pehle ek detail yaad dila do?", "Haan."]],
    ["Uska naam kya hai?", "sister_name", ["Meri dukaan ke naam ki baat karein?", "Zaroor.", "Actually meri behen ki baat karte hain.", "Bilkul."]],
    ["Rainbow mein kitne rang hote hain?", undefined, ["Meri dukaan ke baare mein baat karein?", "Zaroor.", "Pehle ek alag sawaal.", "Poochho."]],
    ["Portugal ki capital kya hai?", undefined, ["Meri shop kis shehar mein hai, uski baat karni hai.", "Bilkul.", "Pehle geography ka ek question.", "Poochho."]],
  ],
};

const userId = "memory-holdout";
const database = openDatabase(":memory:");
try {
  const { message } = database.saveUserMessage({
    userId, channel: "text", content: "Synthetic memory fixture.",
    clientMessageId: userId, generationId: userId,
  });
  assert(database.applyMemoryChanges({
    userId, sourceMessageId: message.id, origin: "extracted",
    operations: Object.entries(facts).map(([key, fact]) => ({ action: "add", key, fact, category: "fixture" })),
  }));

  const embedder = createMemoryEmbedder();
  const compare = process.argv.includes("--compare-context");
  const windows = compare ? [2, 4] as const : [undefined];
  const memories = windows.map((messages) => ({
    messages,
    memory: createMemoryRetriever(database, embedder, { contextMessages: messages }),
  }));
  await memories[0]!.memory.index(userId);
  console.log(JSON.stringify({ embeddings: embedder.id, facts: Object.keys(facts).length }));

  const groups = [{ group: "original", probes: questions }];
  if (compare) groups.push({ group: "fourMessageHistory", probes: longContextQuestions });
  for (const { group, probes } of groups) {
    for (const { memory, messages } of memories) {
      const timings: number[] = [];
      const summary: Record<string, { hits: number; expected: number; zero: number; unrelated: number }> = {};
      for (const [language, cases] of Object.entries(probes)) {
        const counts = { hits: 0, expected: 0, zero: 0, unrelated: 0 };
        for (const [question, expectedKey, previous] of cases) {
          const context: ModelMessage[] = (previous ?? []).map((content, i) => ({
            role: i % 2 === 0 ? "user" : "assistant", content,
          }));
          const start = performance.now();
          const selected = await memory.retrieve(userId, context, [question]);
          timings.push(performance.now() - start);
          const keys = selected.map(({ key }) => key);
          if (expectedKey) {
            counts.expected++;
            if (keys.includes(expectedKey)) counts.hits++;
          } else {
            counts.unrelated++;
            if (!keys.length) counts.zero++;
          }
          console.log(JSON.stringify({ group, messages, language, question, expectedKey: expectedKey ?? null, keys }));
        }
        summary[language] = counts;
      }
      timings.sort((a, b) => a - b);
      console.log(JSON.stringify({
        group, messages, summary, medianMs: Math.round(timings[Math.floor(timings.length / 2)]), maxMs: Math.round(timings.at(-1)!),
      }));
    }
  }
} finally {
  database.close();
}
