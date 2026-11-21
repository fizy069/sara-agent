import { createOpenAI } from "@ai-sdk/openai";

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("Set OPENAI_API_KEY in .env before starting Sara.");

const provider = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL });

export function chatModel(id: string) {
  return provider.responses(id);
}

export function memoryModel(id: string) {
  return provider.responses(id);
}
