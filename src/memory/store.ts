import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { MemoryFact, MemoryOperation } from "./operations.js";

interface MemoryChanges {
  userId: string;
  sourceMessageId: string;
  origin: "explicit" | "extracted";
  operations: readonly MemoryOperation[];
}

export interface MemoryStore {
  getMemories(userId: string): MemoryFact[];
  applyMemoryChanges(changes: MemoryChanges): boolean;
}

export interface MemoryCandidate extends MemoryFact {
  id: string;
  vector: Buffer | null;
}

export interface MemoryVectorStore extends MemoryStore {
  getMemoryCandidates(userId: string, model: string): MemoryCandidate[];
  saveMemoryVectors(userId: string, model: string, vectors: readonly { id: string; vector: Buffer }[]): void;
}

function searchable(text: string): string {
  return ` ${text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim()} `;
}

export function createMemoryStore(database: Database.Database): MemoryVectorStore {
  const list = database.prepare<[string], MemoryFact>(
    "SELECT key, fact, category FROM memories WHERE user_id = ? AND status = 'active' ORDER BY key",
  );
  const candidates = database.prepare<[string, string], MemoryCandidate>(
    `SELECT memory.id, memory.key, memory.fact, memory.category, embedding.vector
      FROM memories AS memory LEFT JOIN memory_embeddings AS embedding
        ON embedding.memory_id = memory.id AND embedding.model = ?
      WHERE memory.user_id = ? AND memory.status = 'active' ORDER BY memory.key`,
  );
  const saveVector = database.prepare<[string, Buffer, string, string]>(
    `INSERT INTO memory_embeddings (memory_id, model, vector)
      SELECT id, ?, ? FROM memories WHERE id = ? AND user_id = ? AND status = 'active'
      ON CONFLICT (memory_id) DO UPDATE SET model = excluded.model, vector = excluded.vector`,
  );
  const saveMemoryVectors = database.transaction((
    userId: string, model: string, vectors: readonly { id: string; vector: Buffer }[],
  ): void => {
    for (const { id, vector } of vectors) saveVector.run(model, vector, id, userId);
  });
  // Extraction from a completed turn can finish after the conversation is cleared.
  const sourceMessage = database.prepare<[string, string, MemoryChanges["origin"]], { row: number; generationId: string }>(
    `SELECT rowid AS row, generation_id AS generationId FROM messages
      WHERE user_id = ? AND id = ? AND role = 'user'
        AND (status = 'committed' OR (status = 'cleared' AND ? = 'extracted'))`,
  );
  const laterForget = database.prepare<[string, number], { found: 1 }>(
    `SELECT 1 AS found FROM memory_deletions AS deletion JOIN messages AS source
      ON source.id = deletion.forget_message_id WHERE deletion.user_id = ? AND source.rowid >= ? LIMIT 1`,
  );
  const active = database.prepare<[string, string], { sourceRow: number | null }>(
    `SELECT source.rowid AS sourceRow FROM memories
      LEFT JOIN messages AS source ON source.id = memories.source_message_id
      WHERE memories.user_id = ? AND key = ? AND memories.status = 'active'`,
  );
  const deleted = database.prepare<[string, string], { sourceRow: number }>(
    `SELECT source.rowid AS sourceRow FROM memory_deletions AS deletion JOIN messages AS source
      ON source.id = deletion.source_message_id WHERE deletion.user_id = ? AND key = ?`,
  );
  const supersede = database.prepare<[string, string], { id: string }>(
    "UPDATE memories SET status = 'superseded' WHERE user_id = ? AND key = ? AND status = 'active' RETURNING id",
  );
  const removeVector = database.prepare<[string]>(
    "DELETE FROM memory_embeddings WHERE memory_id = ?",
  );
  const insert = database.prepare<MemoryFact & { id: string; userId: string; sourceMessageId: string; updatedAt: string }>(
    `INSERT INTO memories (id, user_id, key, fact, category, source_message_id, status, updated_at)
      VALUES (@id, @userId, @key, @fact, @category, @sourceMessageId, 'active', @updatedAt)`,
  );
  const remove = database.prepare<[string, string], { fact: string; sourceMessageId: string | null }>(
    "DELETE FROM memories WHERE user_id = ? AND key = ? RETURNING fact, source_message_id AS sourceMessageId",
  );
  const recordDeletion = database.prepare<[string, string, string, string | null]>(
    `INSERT INTO memory_deletions (user_id, key, source_message_id, forget_message_id) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, key) DO UPDATE SET
        source_message_id = excluded.source_message_id,
        forget_message_id = COALESCE(excluded.forget_message_id, memory_deletions.forget_message_id)`,
  );
  const priorMessages = database.prepare<[string, number], {
    id: string; content: string; modelJson: string; generationId: string;
  }>(
    `SELECT id, content, model_json AS modelJson, generation_id AS generationId FROM messages
      WHERE user_id = ? AND rowid <= ? AND status = 'committed'`,
  );
  const hideGeneration = database.prepare<[string, string]>(
    "INSERT INTO hidden_model_generations (user_id, generation_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );

  const applyMemoryChanges = database.transaction(({
    userId, sourceMessageId, origin, operations,
  }: MemoryChanges): boolean => {
    const source = sourceMessage.get(userId, sourceMessageId, origin);
    if (!source || (origin === "extracted" && laterForget.get(userId, source.row))) return false;

    const updatedAt = new Date().toISOString();
    let changed = false;
    for (const operation of operations) {
      const { key } = operation;
      const currentRow = active.get(userId, key)?.sourceRow ?? 0;
      const deletedRow = deleted.get(userId, key)?.sourceRow ?? 0;
      if (currentRow > source.row || (origin === "extracted" && currentRow === source.row)) continue;
      if (deletedRow > source.row || (deletedRow === source.row && operation.action !== "delete")) continue;

      if (operation.action === "delete") {
        const removed = remove.all(userId, key);
        recordDeletion.run(userId, key, sourceMessageId, origin === "explicit" ? sourceMessageId : null);
        if (origin === "explicit") {
          const sourceIds = new Set(removed.map((memory) => memory.sourceMessageId));
          const terms = [...(operation.historyTerms ?? []), ...removed.map((memory) => memory.fact)]
            .map(searchable).filter((term) => term.trim());

          // Hide whole generations to keep replayed tool calls paired with their results.
          const generations = new Set([source.generationId]);
          for (const message of priorMessages.iterate(userId, source.row)) {
            if (generations.has(message.generationId)) continue;
            const text = searchable(`${message.content}\n${message.modelJson}`);
            if (sourceIds.has(message.id) || terms.some((term) => text.includes(term))) {
              generations.add(message.generationId);
            }
          }
          for (const generationId of generations) hideGeneration.run(userId, generationId);
        }
      } else {
        const previous = supersede.get(userId, key);
        if (previous) removeVector.run(previous.id);
        insert.run({ ...operation, id: randomUUID(), userId, sourceMessageId, updatedAt });
      }
      changed = true;
    }
    return changed;
  });

  return {
    getMemories: (userId) => list.all(userId),
    getMemoryCandidates: (userId, model) => candidates.all(model, userId),
    saveMemoryVectors: saveMemoryVectors.immediate,
    applyMemoryChanges: applyMemoryChanges.immediate,
  };
}
