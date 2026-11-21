import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { modelMessageSchema, type ModelMessage } from "ai";
import Database from "better-sqlite3";
import { assistantText } from "./engine/messages.js";
import { createMemoryStore, type MemoryStore } from "./memory/store.js";

export type Channel = "text" | "voice";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  clientMessageId: string | null;
  createdAt: string;
}

interface SaveUserMessage {
  userId: string;
  channel: Channel;
  content: string;
  clientMessageId: string;
  generationId: string;
}

interface SavedUserMessage {
  message: ChatMessage;
  generationId: string;
  created: boolean;
}

interface CommitTurn {
  userId: string;
  channel: Channel;
  generationId: string;
  messages: readonly ModelMessage[];
}

export interface SaraDatabase extends MemoryStore {
  saveUserMessage(input: SaveUserMessage): SavedUserMessage;
  getHistory(userId: string): ChatMessage[];
  clearHistory(userId: string): void;
  getModelHistory(userId: string, limit?: number, beforeMessageId?: string): ModelMessage[];
  commitTurn(input: CommitTurn): ChatMessage;
  close(): void;
}

export class MessageIdConflictError extends Error {
  constructor(message = "This client message ID has already been used for a different message.") {
    super(message);
    this.name = "MessageIdConflictError";
  }
}

interface MessageRow {
  id: string;
  userId: string;
  role: ModelMessage["role"];
  channel: Channel;
  content: string;
  modelJson: string;
  clientMessageId: string | null;
  generationId: string;
  createdAt: string;
}

const migrations = [
  `CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    channel TEXT NOT NULL CHECK (channel IN ('text', 'voice')),
    content TEXT NOT NULL,
    model_json TEXT NOT NULL,
    client_message_id TEXT UNIQUE,
    generation_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'committed',
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_by_thread ON messages(user_id, status);

  CREATE TABLE memories (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    fact TEXT NOT NULL,
    category TEXT NOT NULL,
    source_message_id TEXT REFERENCES messages(id),
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX active_memory_by_key
    ON memories(user_id, key) WHERE status = 'active';`,

  `CREATE TABLE memory_deletions (
    user_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    forget_message_id TEXT REFERENCES messages(id),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE hidden_model_generations (
    user_id TEXT NOT NULL REFERENCES users(id),
    generation_id TEXT NOT NULL,
    PRIMARY KEY (user_id, generation_id)
  );`,
];

function migrate(database: Database.Database): void {
  const applyMigrations = database.transaction(() => {
    const version = database.pragma("user_version", { simple: true }) as number;
    if (version > migrations.length) {
      throw new Error(`Unsupported Sara database schema version ${version}`);
    }
    for (const [offset, sql] of migrations.slice(version).entries()) {
      database.exec(sql);
      database.pragma(`user_version = ${version + offset + 1}`);
    }
  });
  applyMigrations.immediate();
}

export function openDatabase(path: string): SaraDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    migrate(database);
    return createStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

function createStore(database: Database.Database): SaraDatabase {
  const insertUser = database.prepare<[string]>(
    "INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING",
  );
  const insertMessage = database.prepare<MessageRow>(
    `INSERT INTO messages
      (id, user_id, role, channel, content, model_json, client_message_id, generation_id, created_at)
      VALUES (@id, @userId, @role, @channel, @content, @modelJson, @clientMessageId,
        @generationId, @createdAt)`,
  );
  const findUserMessage = database.prepare<
    [string],
    ChatMessage & Pick<MessageRow, "userId" | "channel" | "generationId"> & { status: string }
  >(
    `SELECT id, role, content, client_message_id AS clientMessageId, created_at AS createdAt,
      user_id AS userId, channel, generation_id AS generationId, status
      FROM messages WHERE client_message_id = ? AND role = 'user'`,
  );
  const history = database.prepare<[string], ChatMessage>(
    `SELECT id, role, content, client_message_id AS clientMessageId, created_at AS createdAt
      FROM messages WHERE user_id = ? AND status = 'committed'
        AND (role = 'user' OR (role = 'assistant' AND content != ''))
      ORDER BY rowid`,
  );
  // Saved memories and forget records reference the original message rows.
  const clearHistory = database.prepare<[string]>(
    "UPDATE messages SET status = 'cleared' WHERE user_id = ? AND status = 'committed'",
  );
  const modelHistory = database.prepare<
    { userId: string; limit: number; beforeMessageId: string | null },
    Pick<MessageRow, "id" | "role" | "modelJson">
  >(
    `SELECT message.id, message.role, message.model_json AS modelJson
      FROM messages AS message WHERE message.user_id = @userId AND message.status = 'committed'
        AND (@beforeMessageId IS NULL OR message.rowid < (SELECT rowid FROM messages WHERE id = @beforeMessageId))
        AND NOT EXISTS (SELECT 1 FROM hidden_model_generations AS hidden
          WHERE hidden.user_id = message.user_id AND hidden.generation_id = message.generation_id)
      ORDER BY message.rowid DESC LIMIT @limit`,
  );

  const saveUserMessage = database.transaction((input: SaveUserMessage): SavedUserMessage => {
    const existing = findUserMessage.get(input.clientMessageId);
    if (existing) {
      const { userId, channel, generationId, status, ...message } = existing;
      if (userId !== input.userId || channel !== input.channel || message.content !== input.content) {
        throw new MessageIdConflictError();
      }
      if (status === "cleared") {
        throw new MessageIdConflictError("This message belongs to a cleared conversation. Send it as a new message.");
      }
      return { message, generationId, created: false };
    }

    const modelMessage: ModelMessage = { role: "user", content: input.content };
    const message: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: input.content,
      clientMessageId: input.clientMessageId,
      createdAt: new Date(Date.now()).toISOString(),
    };
    insertUser.run(input.userId);
    insertMessage.run({ ...input, ...message, modelJson: JSON.stringify(modelMessage) });
    return { message, generationId: input.generationId, created: true };
  });

  const commitTurn = database.transaction((input: CommitTurn): ChatMessage => {
    if (input.messages.at(-1)?.role !== "assistant") {
      throw new Error("A completed turn must end with an assistant message.");
    }

    const content = assistantText(input.messages);
    const finalId = randomUUID();
    const createdAt = new Date(Date.now()).toISOString();
    for (const [index, message] of input.messages.entries()) {
      const isFinal = index === input.messages.length - 1;
      insertMessage.run({
        id: isFinal ? finalId : randomUUID(),
        userId: input.userId,
        role: message.role,
        channel: input.channel,
        content: isFinal ? content : "",
        modelJson: JSON.stringify(message),
        clientMessageId: null,
        generationId: input.generationId,
        createdAt,
      });
    }
    return { id: finalId, role: "assistant", content, clientMessageId: null, createdAt };
  });

  return {
    ...createMemoryStore(database),
    saveUserMessage: saveUserMessage.immediate,
    getHistory: (userId) => history.all(userId),
    clearHistory(userId) {
      clearHistory.run(userId);
    },
    getModelHistory(userId, limit = 12, beforeMessageId) {
      const rows = modelHistory.all({ userId, limit, beforeMessageId: beforeMessageId ?? null }).reverse();
      // Start at the first user message inside the window so tool calls and results stay together.
      const start = rows.findIndex((row) => row.role === "user");
      if (start < 0) return [];
      return rows.slice(start).map(({ id, role, modelJson }) => {
        try {
          const message = modelMessageSchema.parse(JSON.parse(modelJson));
          if (message.role !== role) throw new Error(`Expected message role ${role}, got ${message.role}`);
          return message;
        } catch (error) {
          throw new Error(`Invalid model history message ${id}`, { cause: error });
        }
      });
    },
    commitTurn: commitTurn.immediate,
    close: () => database.close(),
  };
}
