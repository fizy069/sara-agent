import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { MessageIdConflictError, openDatabase } from "./db.js";
import { ThreadCoordinator } from "./engine/coordinator.js";
import { createModels } from "./engine/models.js";
import { createTurnEngine } from "./engine/turn.js";
import { createMemoryExtractor } from "./memory/extractor.js";

const reasoning = process.env.SARA_CHAT_REASONING ?? "none";
if (reasoning !== "none" && reasoning !== "low") {
  throw new Error("SARA_CHAT_REASONING must be none or low.");
}

const models = createModels();
const database = openDatabase(process.env.SARA_DB_PATH ?? "data/sara.sqlite");
const engine = createTurnEngine(database, {
  model: models.chat,
  reasoning,
});
const extract = createMemoryExtractor({
  model: models.memory,
  ...(models.provider === "ollama" ? { reasoning: "none", temperature: 0, timeout: 60_000 } : {}),
});
const coordinator = new ThreadCoordinator(database, engine, extract);
const app = new Hono();
const users = new Hono();

app.get("/", (c) => c.html(readFileSync(new URL("../web/index.html", import.meta.url), "utf8")));

users.use("/:uid/*", async (c, next) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(c.req.param("uid"))) {
    return c.json({ error: "Invalid user ID." }, 400);
  }
  c.header("Cache-Control", "no-store");
  await next();
});

users.get("/:uid/history", (c) => c.json({ messages: database.getHistory(c.req.param("uid")) }));
users.get("/:uid/memories", (c) => c.json({ memories: database.getMemories(c.req.param("uid")) }));

users.get("/:uid/events", (c) => {
  const userId = c.req.param("uid");
  return streamSSE(c, async (stream) => {
    const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
    const unsubscribe = coordinator.subscribe(userId, ({ type, ...data }) => {
      void stream.writeSSE({ event: type, data: JSON.stringify(data) });
    });
    const heartbeat = setInterval(() => void stream.write(": keep-alive\n\n"), 15_000);
    try {
      await stream.write(": ready\n\n");
      await closed;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

users.post(
  "/:uid/messages",
  bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "Message is too large." }, 413) }),
  async (c) => {
    if (c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return c.json({ error: "Send messages as JSON." }, 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON." }, 400);
    }

    const { content, clientMessageId } = (body ?? {}) as Record<string, unknown>;
    if (typeof content !== "string" || !content.trim() || content.length > 4_000) {
      return c.json({ error: "Enter a message of 1 to 4,000 characters." }, 400);
    }
    if (typeof clientMessageId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientMessageId)) {
      return c.json({ error: "Invalid client message ID." }, 400);
    }

    try {
      return c.json(coordinator.submit(c.req.param("uid"), content.trim(), clientMessageId), 202);
    } catch (error) {
      if (error instanceof MessageIdConflictError) return c.json({ error: error.message }, 409);
      throw error;
    }
  },
);

app.route("/api/users", users);

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid PORT.");
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (address) => {
  console.log(`Sara is using ${models.provider} (chat: ${models.chat.modelId}, memory: ${models.memory.modelId})`);
  console.log(`Sara is listening at http://${hostname}:${address.port}`);
});
