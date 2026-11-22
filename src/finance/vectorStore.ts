import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { financeEmbeddingDimensions } from "./embeddings.js";

export const defaultFinanceIndexPath = "data/finance.sqlite";

interface FinanceDocument {
  title: string;
  publisher: string;
  url: string;
  content: string;
}

type IndexedDocument = FinanceDocument & { embedding: number[] };

function openIndex(path: string, readonly = false) {
  const database = new Database(path, { readonly });
  try {
    sqliteVec.load(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function vectorBuffer(embedding: number[]) {
  return Buffer.from(Float32Array.from(embedding).buffer);
}

export function replaceFinanceIndex(path: string, documents: readonly IndexedDocument[]) {
  mkdirSync(dirname(path), { recursive: true });
  const database = openIndex(path);
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS finance_documents (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          publisher TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          content TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS finance_embeddings USING vec0(
          embedding float[${financeEmbeddingDimensions}] distance_metric=cosine
        );
        DELETE FROM finance_embeddings;
        DELETE FROM finance_documents;
      `);
      const insertDocument = database.prepare(`
        INSERT INTO finance_documents (title, publisher, url, content)
        VALUES (@title, @publisher, @url, @content)
      `);
      const insertEmbedding = database.prepare("INSERT INTO finance_embeddings (rowid, embedding) VALUES (?, ?)");
      for (const { embedding, ...document } of documents) {
        const { lastInsertRowid } = insertDocument.run(document);
        insertEmbedding.run(BigInt(lastInsertRowid), vectorBuffer(embedding));
      }
    }).immediate();
  } finally {
    database.close();
  }
}

export function nearestFinanceDocument(path: string, embedding: number[]) {
  const database = openIndex(path, true);
  try {
    return database.prepare<[Buffer], FinanceDocument & { distance: number }>(`
      SELECT title, publisher, url, content, distance
      FROM (
        SELECT rowid, distance FROM finance_embeddings
        WHERE embedding MATCH ? AND k = 1
        ORDER BY distance
      ) AS nearest
      JOIN finance_documents ON finance_documents.id = nearest.rowid
    `).get(vectorBuffer(embedding));
  } finally {
    database.close();
  }
}
