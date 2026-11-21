import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { AccessToken, RoomAgentDispatch, RoomConfiguration, TrackSource } from "livekit-server-sdk";
import { MessageIdConflictError, openDatabase, type Channel } from "./db.js";
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
const voice = new Hono();
const agentToken = process.env.SARA_AGENT_TOKEN;
const livekitUrl = process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880";
const livekitKey = process.env.LIVEKIT_API_KEY ?? "devkey";
const livekitSecret = process.env.LIVEKIT_API_SECRET ?? "secret";
const require = createRequire(import.meta.url);

app.get("/", (c) => c.html(readFileSync(new URL("../web/index.html", import.meta.url), "utf8")));
app.get("/livekit-client.js", (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  return c.body(readFileSync(require.resolve("livekit-client"), "utf8"));
});

const validateUser = createMiddleware(async (c, next) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(c.req.param("uid") ?? "")) {
    return c.json({ error: "Invalid user ID." }, 400);
  }
  c.header("Cache-Control", "no-store");
  await next();
});
users.use("/:uid/*", validateUser);
voice.use("/:uid/*", validateUser);

users.get("/:uid/history", (c) => c.json({ messages: database.getHistory(c.req.param("uid")) }));
users.delete("/:uid/history", (c) => {
  coordinator.clearHistory(c.req.param("uid"));
  return c.body(null, 204);
});
users.get("/:uid/memories", (c) => c.json({ memories: database.getMemories(c.req.param("uid")) }));

users.post("/:uid/call", async (c) => {
  if (!agentToken) return c.json({ error: "Voice is unavailable. Set SARA_AGENT_TOKEN to enable calls." }, 503);

  const userId = c.req.param("uid");
  const room = `sara-${userId}-${randomUUID()}`;
  const token = new AccessToken(livekitKey, livekitSecret, { identity: userId, ttl: "10m" });
  token.addGrant({ roomJoin: true, room, canPublishSources: [TrackSource.MICROPHONE], canPublishData: false });
  token.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: "sara", metadata: JSON.stringify({ userId }) })],
  });
  return c.json({ url: livekitUrl, token: await token.toJwt() });
});

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

function streamVoiceTurn(c: Context, userId: string, generationId: string) {
  return streamSSE(c, async (stream) => {
    const ended = Promise.withResolvers<void>();
    let terminal = false;
    const unsubscribe = coordinator.subscribe(userId, (event) => {
      if (terminal) return;
      if (event.type === "history-cleared") {
        terminal = true;
        void stream.writeSSE({ event: "cancelled", data: JSON.stringify({ generationId }) }).then(ended.resolve);
        return;
      }
      const { type, ...data } = event;
      if (data.generationId !== generationId || type === "typing" || type === "memories") return;

      terminal = type === "done" || type === "cancelled";
      const written = stream.writeSSE({ event: type, data: JSON.stringify(data) });
      if (terminal) void written.then(ended.resolve);
    });
    stream.onAbort(() => {
      if (!terminal) coordinator.cancel(userId, generationId);
      ended.resolve();
    });
    try {
      await stream.write(": ready\n\n");
      await ended.promise;
    } finally {
      unsubscribe();
    }
  });
}

async function submitMessage(c: Context, userId: string, channel: Channel) {
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
    const { message, generationId, created } = coordinator.submit(userId, content.trim(), clientMessageId, channel);
    if (channel === "text") return c.json({ message, generationId }, 202);
    if (!created) return c.json({ error: "This voice turn was already submitted." }, 409);
    return streamVoiceTurn(c, userId, generationId);
  } catch (error) {
    if (error instanceof MessageIdConflictError) return c.json({ error: error.message }, 409);
    throw error;
  }
}

const limitMessageBody = bodyLimit({
  maxSize: 32 * 1024,
  onError: (c) => c.json({ error: "Message is too large." }, 413),
});
users.post("/:uid/messages", limitMessageBody, (c) => submitMessage(c, c.req.param("uid"), "text"));
voice.post(
  "/:uid/turn",
  async (c, next) => {
    if (!agentToken || c.req.header("Authorization") !== `Bearer ${agentToken}`) {
      return c.json({ error: "Invalid voice worker credentials." }, 401);
    }
    await next();
  },
  limitMessageBody,
  (c) => submitMessage(c, c.req.param("uid"), "voice"),
);

app.route("/api/users", users);
app.route("/api/voice/users", voice);

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid PORT.");
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (address) => {
  console.log(`Sara is using ${models.provider} (chat: ${models.chat.modelId}, memory: ${models.memory.modelId})`);
  console.log(`Sara is listening at http://${hostname}:${address.port}`);
});
