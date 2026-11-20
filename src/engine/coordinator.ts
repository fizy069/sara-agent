import { randomUUID } from "node:crypto";
import type { ChatMessage, SaraDatabase } from "../db.js";
import type { TurnEngine } from "./turn.js";

export type SaraEvent = { generationId: string } & (
  | { type: "typing"; userMessage: ChatMessage }
  | { type: "delta"; delta: string }
  | { type: "done"; assistantMessage: ChatMessage }
  | { type: "cancelled"; reason?: string }
);

interface Generation {
  id: string;
  controller: AbortController;
  settled: Promise<void>;
}

type Listener = (event: SaraEvent) => void;

export class ThreadCoordinator {
  private readonly active = new Map<string, Generation>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly database: SaraDatabase,
    private readonly engine: TurnEngine,
  ) {}

  subscribe(userId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(userId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(userId);
    };
  }

  submit(userId: string, content: string, clientMessageId: string) {
    const saved = this.database.saveUserMessage({
      userId, channel: "text", content, clientMessageId, generationId: randomUUID(),
    });
    const { message, generationId } = saved;
    if (!saved.created) return { message, generationId };

    const previous = this.active.get(userId);
    const controller = new AbortController();
    const settled = (previous?.settled ?? Promise.resolve()).then(
      () => this.generate(userId, generationId, message, controller.signal),
    );
    this.active.set(userId, { id: generationId, controller, settled });
    if (previous) {
      previous.controller.abort();
      this.publish(userId, { type: "cancelled", generationId: previous.id });
    }
    this.publish(userId, { type: "typing", generationId, userMessage: message });
    return { message, generationId };
  }

  private async generate(userId: string, generationId: string, message: ChatMessage, signal: AbortSignal) {
    if (signal.aborted) return;
    try {
      const channel = "text";
      for await (const event of this.engine.run({ userId, channel, utterances: [message], signal })) {
        if (this.active.get(userId)?.id !== generationId) continue;
        if (event.type === "delta") {
          this.publish(userId, { ...event, generationId });
        } else {
          const assistantMessage = this.database.commitTurn({
            userId, generationId, channel, messages: event.messages,
          });
          this.publish(userId, { type: "done", generationId, assistantMessage });
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error("Sara turn failed", error instanceof Error ? error.message : error);
        this.publish(userId, {
          type: "cancelled",
          generationId,
          reason: "Sara couldn’t reply. Try sending a new message.",
        });
      }
    } finally {
      if (this.active.get(userId)?.id === generationId) this.active.delete(userId);
    }
  }

  private publish(userId: string, event: SaraEvent) {
    for (const listener of this.listeners.get(userId) ?? []) listener(event);
  }
}
