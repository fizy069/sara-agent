import type { ToolSet } from "ai";
import type { MemoryStore } from "../memory/store.js";
import { calculateEmi } from "./emi.js";
import { lookupFinance } from "./financeKb.js";
import { createMemoryTool } from "./memoryTool.js";

interface ToolContext {
  store: MemoryStore;
  userId: string;
  sourceMessageId: string;
}

export function createTools({ store, userId, sourceMessageId }: ToolContext) {
  return {
    calculate_emi: calculateEmi,
    lookup_finance: lookupFinance,
    forget_or_correct_memory: createMemoryTool(store, userId, sourceMessageId),
  } satisfies ToolSet;
}
