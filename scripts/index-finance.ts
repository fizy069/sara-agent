import { load } from "cheerio";
import { embedFinanceText } from "../src/finance/embeddings.js";
import { financeSources } from "../src/finance/sources.js";
import { defaultFinanceIndexPath, replaceFinanceIndex } from "../src/finance/vectorStore.js";

const documents = await Promise.all(financeSources.map(async ({ selector, ...source }) => {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not fetch ${source.url} (HTTP ${response.status}).`);

  const $ = load(await response.text());
  const article = $(selector);
  if (article.length !== 1) throw new Error(`Expected one article at ${source.url}.`);
  article.find("script, style, noscript").remove();
  article.find("br").replaceWith("\n");
  article.find("p, div, li, h1, h2, h3, h4, h5, tr").after("\n");
  article.find("th, td").after(" | ");
  const content = article.text().split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim().replace(/(?:\s*\|)+$/, ""))
    .filter(Boolean)
    .join("\n");
  if (content.length < 200) throw new Error(`Article text is incomplete at ${source.url}.`);
  return { ...source, content };
}));

const inputs = documents.map(({ title, content }) => `${title}\n\n${content}`);
const embeddings = await embedFinanceText(inputs, AbortSignal.timeout(120_000));
const path = process.env.SARA_FINANCE_DB_PATH ?? defaultFinanceIndexPath;
replaceFinanceIndex(path, documents.map((document, index) => ({ ...document, embedding: embeddings[index] })));
console.log(`Indexed ${documents.length} complete finance documents in ${path}.`);
