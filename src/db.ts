import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
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
  messages: readonly (AssistantMessage | ToolResultMessage)[];
}

export interface SaraDatabase extends MemoryStore {
  saveUserMessage(input: SaveUserMessage): SavedUserMessage;
  getHistory(userId: string): ChatMessage[];
  getModelHistory(userId: string, limit?: number, beforeMessageId?: string): Message[];
  commitTurn(input: CommitTurn): ChatMessage;
  close(): void;
}

export class MessageIdConflictError extends Error {
  constructor() {
    super("This client message ID has already been used for a different message.");
    this.name = "MessageIdConflictError";
  }
}

interface MessageRow {
  id: string;
  userId: string;
  role: Message["role"];
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
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
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
    ChatMessage & Pick<MessageRow, "userId" | "channel" | "generationId">
  >(
    `SELECT id, role, content, client_message_id AS clientMessageId, created_at AS createdAt,
      user_id AS userId, channel, generation_id AS generationId
      FROM messages WHERE client_message_id = ? AND role = 'user'`,
  );
  const history = database.prepare<[string], ChatMessage>(
    `SELECT id, role, content, client_message_id AS clientMessageId, created_at AS createdAt
      FROM messages WHERE user_id = ? AND status = 'committed'
        AND (role = 'user' OR (role = 'assistant' AND content != ''))
      ORDER BY rowid`,
  );
  const modelHistory = database.prepare<
    { userId: string; limit: number; beforeMessageId: string | null },
    { role: Message["role"]; modelJson: string }
  >(
    `SELECT message.role, message.model_json AS modelJson
      FROM messages AS message WHERE message.user_id = @userId AND message.status = 'committed'
        AND (@beforeMessageId IS NULL OR message.rowid < (SELECT rowid FROM messages WHERE id = @beforeMessageId))
        AND NOT EXISTS (SELECT 1 FROM hidden_model_generations AS hidden
          WHERE hidden.user_id = message.user_id AND hidden.generation_id = message.generation_id)
      ORDER BY message.rowid DESC LIMIT @limit`,
  );

  const saveUserMessage = database.transaction((input: SaveUserMessage): SavedUserMessage => {
    const existing = findUserMessage.get(input.clientMessageId);
    if (existing) {
      const { userId, channel, generationId, ...message } = existing;
      if (userId !== input.userId || channel !== input.channel || message.content !== input.content) {
        throw new MessageIdConflictError();
      }
      return { message, generationId, created: false };
    }

    const modelMessage: UserMessage = { role: "user", content: input.content, timestamp: Date.now() };
    const message: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: input.content,
      clientMessageId: input.clientMessageId,
      createdAt: new Date(modelMessage.timestamp).toISOString(),
    };
    insertUser.run(input.userId);
    insertMessage.run({ ...input, ...message, modelJson: JSON.stringify(modelMessage) });
    return { message, generationId: input.generationId, created: true };
  });

  const commitTurn = database.transaction((input: CommitTurn): ChatMessage => {
    const finalMessage = input.messages.at(-1);
    if (finalMessage?.role !== "assistant") {
      throw new Error("A completed turn must end with an assistant message.");
    }

    const content = input.messages
      .flatMap((message) => message.role === "assistant" ? message.content : [])
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("");
    const finalId = randomUUID();
    const finalCreatedAt = new Date(finalMessage.timestamp).toISOString();
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
        createdAt: new Date(message.timestamp).toISOString(),
      });
    }
    return { id: finalId, role: "assistant", content, clientMessageId: null, createdAt: finalCreatedAt };
  });

  return {
    ...createMemoryStore(database),
    saveUserMessage: saveUserMessage.immediate,
    getHistory: (userId) => history.all(userId),
    getModelHistory(userId, limit = 12, beforeMessageId) {
      const rows = modelHistory.all({ userId, limit, beforeMessageId: beforeMessageId ?? null }).reverse();
      // Start at the first user message inside the window so tool calls and results stay together.
      const start = rows.findIndex((row) => row.role === "user");
      return start < 0 ? [] : rows.slice(start).map((row) => JSON.parse(row.modelJson) as Message);
    },
    commitTurn: commitTurn.immediate,
    close: () => database.close(),
  };
}
