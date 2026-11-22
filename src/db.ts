import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { modelMessageSchema, type ModelMessage } from "ai";
import Database from "better-sqlite3";
import { conversationTokenBudget, estimateMessageTokens, summaryContext } from "./engine/context.js";
import { assistantText } from "./engine/messages.js";
import { createMemoryStore, type MemoryStore } from "./memory/store.js";

export type Channel = "text" | "voice";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  channel: Channel;
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

interface SummaryUpdate {
  throughRow: number;
  previousThroughRow: number;
  hiddenVersion: number;
  messages: Pick<ChatMessage, "role" | "content">[];
}

interface ModelContext {
  messages: ModelMessage[];
  summary?: string;
  update?: SummaryUpdate;
}

export interface SaraDatabase extends MemoryStore {
  saveUserMessage(input: SaveUserMessage): SavedUserMessage;
  getHistory(userId: string): ChatMessage[];
  clearHistory(userId: string): void;
  getModelHistory(userId: string, tokenBudget?: number, beforeMessageId?: string): ModelMessage[];
  getModelContext(userId: string, beforeMessageId: string, tokenBudget: number, summaryBudget: number, refresh?: boolean): ModelContext;
  saveConversationSummary(userId: string, beforeMessageId: string, update: SummaryUpdate, summary: string): void;
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

type ModelHistoryRow = Pick<MessageRow, "id" | "role" | "modelJson"> & { row: number };

function parseModelHistory(rows: readonly ModelHistoryRow[]): ModelMessage[] {
  return rows.map(({ id, role, modelJson }) => {
    try {
      const message = modelMessageSchema.parse(JSON.parse(modelJson));
      if (message.role !== role) throw new Error(`Expected message role ${role}, got ${message.role}`);
      return message;
    } catch (error) {
      throw new Error(`Invalid model history message ${id}`, { cause: error });
    }
  });
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

  `CREATE TABLE conversation_summaries (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
    through_row INTEGER NOT NULL,
    summary TEXT NOT NULL
  );

  CREATE TRIGGER invalidate_summary_on_forget AFTER INSERT ON hidden_model_generations
  BEGIN
    DELETE FROM conversation_summaries WHERE user_id = NEW.user_id;
  END;`,
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
    ChatMessage & Pick<MessageRow, "userId" | "generationId"> & { status: string }
  >(
    `SELECT id, role, content, client_message_id AS clientMessageId, created_at AS createdAt,
      user_id AS userId, channel, generation_id AS generationId, status
      FROM messages WHERE client_message_id = ? AND role = 'user'`,
  );
  const history = database.prepare<[string], ChatMessage>(
    `SELECT id, role, channel, content, client_message_id AS clientMessageId, created_at AS createdAt
      FROM messages WHERE user_id = ? AND status = 'committed'
        AND (role = 'user' OR (role = 'assistant' AND content != ''))
      ORDER BY rowid`,
  );
  // Saved memories and forget records reference the original message rows.
  const clearMessages = database.prepare<[string]>(
    "UPDATE messages SET status = 'cleared' WHERE user_id = ? AND status = 'committed'",
  );
  const clearSummary = database.prepare<[string]>("DELETE FROM conversation_summaries WHERE user_id = ?");
  const clearHistory = database.transaction((userId: string) => {
    clearMessages.run(userId);
    clearSummary.run(userId);
  });
  const messageRow = database.prepare<[string, string], { row: number }>(
    "SELECT rowid AS row FROM messages WHERE user_id = ? AND id = ? AND status = 'committed'",
  );
  const visibleHistory = `FROM messages AS message WHERE message.user_id = @userId AND message.status = 'committed'
    AND message.rowid > @afterRow AND (@beforeRow IS NULL OR message.rowid < @beforeRow)
    AND NOT EXISTS (SELECT 1 FROM hidden_model_generations AS hidden
      WHERE hidden.user_id = message.user_id AND hidden.generation_id = message.generation_id)`;
  type HistoryRange = { userId: string; beforeRow: number | null; afterRow: number };
  const modelHistory = database.prepare<HistoryRange, ModelHistoryRow>(
    `SELECT message.rowid AS row, message.id, message.role, message.model_json AS modelJson
      ${visibleHistory} ORDER BY message.rowid DESC`,
  );
  const summaryHistory = database.prepare<HistoryRange, SummaryUpdate["messages"][number] & { row: number }>(
    `SELECT message.rowid AS row, message.role, substr(message.content, 1, 240) AS content
      ${visibleHistory} AND message.role IN ('user', 'assistant') AND message.content <> ''
      ORDER BY message.rowid LIMIT 10`,
  );
  const findSummary = database.prepare<[string], { throughRow: number; summary: string }>(
    "SELECT through_row AS throughRow, summary FROM conversation_summaries WHERE user_id = ?",
  );
  const hiddenVersion = database.prepare<[string], { version: number }>(
    "SELECT COALESCE(MAX(rowid), 0) AS version FROM hidden_model_generations WHERE user_id = ?",
  );
  const upsertSummary = database.prepare<[string, number, string]>(
    `INSERT INTO conversation_summaries (user_id, through_row, summary) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET through_row = excluded.through_row, summary = excluded.summary`,
  );

  function readModelHistory(range: HistoryRange, tokenBudget: number) {
    const rows: ModelHistoryRow[] = [];
    let completeLength = 0;
    let overflow = false;
    for (const row of modelHistory.iterate(range)) {
      tokenBudget -= estimateMessageTokens(row.modelJson);
      if (tokenBudget < 0) {
        overflow = true;
        break;
      }
      rows.push(row);
      // Start with a user message so an exchange's tool calls and results stay together.
      if (row.role === "user") completeLength = rows.length;
    }
    return { rows: rows.slice(0, completeLength).reverse(), overflow: overflow || completeLength < rows.length };
  }

  const getModelContext = database.transaction((
    userId: string, beforeMessageId: string, tokenBudget: number, summaryBudget: number, refresh = true,
  ): ModelContext => {
    const beforeRow = messageRow.get(userId, beforeMessageId)?.row;
    if (beforeRow === undefined) return { messages: [] };

    const saved = findSummary.get(userId);
    const useSummary = saved && saved.throughRow < beforeRow
      && estimateMessageTokens(summaryContext(saved.summary)) <= summaryBudget;
    const range = { userId, beforeRow, afterRow: useSummary ? saved.throughRow : 0 };
    const summary = useSummary ? saved.summary : undefined;
    const recentBudget = tokenBudget - (summary ? estimateMessageTokens(summaryContext(summary)) : 0);
    const recent = readModelHistory(range, recentBudget);
    const context = { messages: parseModelHistory(recent.rows), summary };
    if (!refresh || !recent.overflow || (saved && !useSummary)) return context;

    // Leave some room for new turns so the summary needn't be refreshed on every message.
    const compacted = readModelHistory(range, tokenBudget - summaryBudget - Math.floor(tokenBudget / 8));
    const older = summaryHistory.all({ ...range, beforeRow: compacted.rows[0]?.row ?? beforeRow });
    const last = older.at(-1);
    if (!last) return context;

    return {
      ...context,
      update: {
        throughRow: last.row,
        previousThroughRow: range.afterRow,
        hiddenVersion: hiddenVersion.get(userId)!.version,
        messages: older.map(({ role, content }) => ({ role, content })),
      },
    };
  });

  const saveConversationSummary = database.transaction((
    userId: string, beforeMessageId: string, update: SummaryUpdate, summary: string,
  ) => {
    // A model call can finish after a clear, forget, or another summary update.
    if (!messageRow.get(userId, beforeMessageId)
      || hiddenVersion.get(userId)!.version !== update.hiddenVersion
      || (findSummary.get(userId)?.throughRow ?? 0) !== update.previousThroughRow) return;
    upsertSummary.run(userId, update.throughRow, summary);
  });

  const saveUserMessage = database.transaction((input: SaveUserMessage): SavedUserMessage => {
    const existing = findUserMessage.get(input.clientMessageId);
    if (existing) {
      const { userId, generationId, status, ...message } = existing;
      if (userId !== input.userId || message.channel !== input.channel || message.content !== input.content) {
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
      channel: input.channel,
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
    return { id: finalId, role: "assistant", channel: input.channel, content, clientMessageId: null, createdAt };
  });

  return {
    ...createMemoryStore(database),
    saveUserMessage: saveUserMessage.immediate,
    getHistory: (userId) => history.all(userId),
    clearHistory: clearHistory.immediate,
    getModelHistory(userId, tokenBudget = conversationTokenBudget(), beforeMessageId) {
      if (tokenBudget <= 0) return [];
      const beforeRow = beforeMessageId ? messageRow.get(userId, beforeMessageId)?.row ?? 0 : null;
      return parseModelHistory(readModelHistory({ userId, beforeRow, afterRow: 0 }, tokenBudget).rows);
    },
    getModelContext,
    saveConversationSummary: saveConversationSummary.immediate,
    commitTurn: commitTurn.immediate,
    close: () => database.close(),
  };
}
