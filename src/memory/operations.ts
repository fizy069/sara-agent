import { z } from "zod";

const key = z.string().max(80).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

export interface MemoryFact {
  key: string;
  fact: string;
  category: string;
}

export const memoryOperationSchema = z.union([
  z.object({
    action: z.enum(["add", "update"]),
    key,
    fact: z.string().trim().min(1).max(500),
    category: z.string().trim().min(1).max(50),
  }),
  z.object({
    action: z.literal("delete"),
    key,
  }),
]);

export type MemoryOperation = z.infer<typeof memoryOperationSchema> & { historyTerms?: readonly string[] };
