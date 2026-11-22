import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { financeEmbeddingDimensions } from "../src/finance/embeddings.js";
import { financeSources } from "../src/finance/sources.js";
import { replaceFinanceIndex } from "../src/finance/vectorStore.js";
import { createLookupFinance } from "../src/tools/financeKb.js";

const context = { toolCallId: "finance-test", messages: [] };
const creditReport = {
  title: "Credit report",
  publisher: "Test publisher",
  url: "https://example.com/credit-report",
  content: "First paragraph.\nSecond paragraph.\nFinal paragraph.",
};
const gstInvoice = {
  title: "GST invoice",
  publisher: "Test publisher",
  url: "https://example.com/gst-invoice",
  content: "Invoice content.",
};

function embedding(...coordinates: number[]) {
  return Array.from({ length: financeEmbeddingDimensions }, (_, index) => coordinates[index] ?? 0);
}

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sara-finance-"));
  path = join(directory, "finance.sqlite");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("lists ten distinct source documents", () => {
  expect(financeSources).toHaveLength(10);
  expect(new Set(financeSources.map(({ url }) => url)).size).toBe(10);
});

test("ranks persisted vectors by cosine similarity and returns the entire source body", async () => {
  replaceFinanceIndex(path, [
    { ...gstInvoice, embedding: embedding(1, 1) },
    { ...creditReport, embedding: embedding(9, 0) },
  ]);
  const lookup = createLookupFinance(path, async () => embedding(1, 0));
  await expect(lookup.execute({ query: "Where can I see my repayment history?" }, context))
    .resolves.toEqual({ status: "match", matches: [creditReport] });
});

test("returns no source when the nearest vector is below the similarity threshold", async () => {
  replaceFinanceIndex(path, [{ ...creditReport, embedding: embedding(1, 0) }]);
  const lookup = createLookupFinance(path, async () => embedding(0, 1));
  await expect(lookup.execute({ query: "How do I bake a cake?" }, context))
    .resolves.toEqual({ status: "no_match", matches: [] });
});

test("keeps the previous index if replacing it fails", async () => {
  replaceFinanceIndex(path, [{ ...creditReport, embedding: embedding(1, 0) }]);
  expect(() => replaceFinanceIndex(path, [{ ...gstInvoice, embedding: [1, 0] }])).toThrow();

  const lookup = createLookupFinance(path, async () => embedding(1, 0));
  await expect(lookup.execute({ query: "credit history" }, context))
    .resolves.toEqual({ status: "match", matches: [creditReport] });
});

test("reports an unavailable index or embedder without preventing a turn", async () => {
  const lookup = createLookupFinance(path, async () => { throw new Error("Ollama is offline"); });
  await expect(lookup.execute({ query: "credit history" }, context))
    .resolves.toEqual({ status: "unavailable", matches: [] });

  replaceFinanceIndex(path, [{ ...creditReport, embedding: embedding(1, 0) }]);
  await expect(lookup.execute({ query: "credit history" }, context))
    .resolves.toEqual({ status: "unavailable", matches: [] });
});
