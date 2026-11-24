import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  cli,
  DEFAULT_API_CONNECT_OPTIONS,
  defineAgent,
  llm,
  ServerOptions,
  type VAD,
  voice,
} from "@livekit/agents";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import { VAD as SileroVAD } from "@livekit/agents-plugin-silero";
import { MacTTS, WhisperSTT } from "./local-speech.js";
import { SarvamTTS } from "./sarvam-tts.js";
import { speechProviders } from "./speech-provider.js";

interface VoiceConfig {
  token: string;
  backendUrl: string;
  stt:
    | { provider: "local"; modelPath: string; executable: string; inferenceUrl?: URL }
    | { provider: "sarvam"; apiKey: string };
  tts: { provider: "local" } | { provider: "sarvam"; apiKey: string; speaker?: string };
}

function sarvamApiKey(): string {
  const apiKey = process.env.SARVAM_API_KEY?.trim();
  if (!apiKey) throw new Error("Set SARVAM_API_KEY to use Sarvam speech.");
  return apiKey;
}

function whisperConfig(): VoiceConfig["stt"] {
  const modelPath = process.env.SARA_WHISPER_MODEL;
  if (!modelPath || !existsSync(modelPath)) {
    throw new Error("Set SARA_WHISPER_MODEL to an existing multilingual Whisper GGML model.");
  }
  const executable = process.env.SARA_WHISPER_BIN ?? "whisper-cli";
  const serverUrl = process.env.SARA_WHISPER_SERVER_URL?.trim();
  if (!serverUrl) return { provider: "local", modelPath, executable };
  const url = URL.parse(serverUrl);
  if (!url || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("SARA_WHISPER_SERVER_URL must be a loopback HTTP origin, such as http://127.0.0.1:8090.");
  }
  return { provider: "local", modelPath, executable, inferenceUrl: new URL("/inference", url) };
}

function voiceConfig(): VoiceConfig {
  const token = process.env.SARA_AGENT_TOKEN;
  if (!token) throw new Error("Set SARA_AGENT_TOKEN to the same value as the Sara backend.");

  const backendUrl = process.env.SARA_BACKEND_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const providers = speechProviders();
  if (process.platform !== "darwin" && (providers.stt === "local" || providers.tts === "local")) {
    throw new Error("Local speech requires macOS. Set SARA_SPEECH_PROVIDER=sarvam for hosted speech.");
  }

  return {
    token,
    backendUrl,
    stt: providers.stt === "local" ? whisperConfig() : { provider: "sarvam", apiKey: sarvamApiKey() },
    tts: providers.tts === "local"
      ? { provider: "local" }
      : { provider: "sarvam", apiKey: sarvamApiKey(), speaker: process.env.SARVAM_TTS_SPEAKER?.trim() || undefined },
  };
}

class SaraBackend extends llm.LLM {
  constructor(private readonly endpoint: URL, private readonly token: string) {
    super();
  }

  label() { return "sara.backend"; }

  chat({ chatCtx }: { chatCtx: llm.ChatContext }): llm.LLMStream {
    return new SaraTurnStream(this, chatCtx, this.endpoint, this.token);
  }
}

class SaraTurnStream extends llm.LLMStream {
  constructor(
    backend: SaraBackend,
    chatCtx: llm.ChatContext,
    private readonly endpoint: URL,
    private readonly token: string,
  ) {
    // A call should never resubmit a turn automatically after a broken connection.
    super(backend, { chatCtx, connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 } });
  }

  protected async run(): Promise<void> {
    const message = this.chatCtx.items.findLast(
      (item) => item.type === "message" && item.role === "user",
    );
    const content = message?.type === "message" ? message.textContent?.trim() : undefined;
    if (!content) return;
    const clientMessageId = randomUUID();
    const signal = this.abortController.signal;
    const speak = (delta: string, id = clientMessageId) => {
      if (!signal.aborted) this.queue.put({ id, delta: { role: "assistant", content: delta } });
    };
    let spoke = false;

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content, clientMessageId }),
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`Sara backend returned HTTP ${response.status}.`);

      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n\n")) !== -1) {
          const event = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const lines = event.split("\n");
          const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = lines.find((line) => line.startsWith("data:"))?.slice(5);
          if (name === "done") return;
          if (!data) continue;
          const { generationId, delta, reason } = JSON.parse(data);
          if (name === "delta" && typeof delta === "string") {
            speak(delta, generationId);
            spoke = true;
          } else if (name === "cancelled") {
            if (reason) throw new Error("Sara backend cancelled the turn with an error.");
            return;
          }
        }
      }
      throw new Error("Sara backend closed the stream before ending the turn.");
    } catch (error) {
      if (signal.aborted) return;
      console.error("Sara voice turn failed:", error instanceof Error ? error.message : error);
      if (!spoke) speak("I couldn’t reply just now. Could you say that again?");
    }
  }
}

export default defineAgent<{ vad: VAD }>({
  prewarm: async (proc) => {
    proc.userData.vad = await SileroVAD.load();
  },
  entry: async (ctx) => {
    const { userId } = JSON.parse(ctx.job.metadata) as { userId?: string };
    if (typeof userId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) {
      throw new Error("Sara call dispatch is missing a valid user ID.");
    }

    const { backendUrl, stt, tts, token } = voiceConfig();
    const endpoint = new URL(`/api/voice/users/${userId}/turn`, backendUrl);

    const session = new voice.AgentSession({
      stt: stt.provider === "local"
        ? new WhisperSTT(stt.executable, stt.modelPath, stt.inferenceUrl)
        : new sarvam.STT({ apiKey: stt.apiKey, model: "saaras:v3", languageCode: "unknown", mode: "codemix" }),
      tts: tts.provider === "local" ? new MacTTS() : new SarvamTTS(tts.apiKey, tts.speaker),
      vad: ctx.proc.userData.vad,
      llm: new SaraBackend(endpoint, token),
      // Browser microphones already use echo cancellation. Keep short replies interruptible.
      aecWarmupDuration: null,
      turnHandling: {
        turnDetection: "vad",
        endpointing: { minDelay: 650 },
        interruption: { mode: "vad", minDuration: 300 },
        preemptiveGeneration: { enabled: false },
      },
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
      if (["eou_metrics", "stt_metrics", "llm_metrics", "tts_metrics"].includes(metrics.type)) {
        console.log("Sara voice timing", JSON.stringify({ room: ctx.room.name, ...metrics }));
      }
    });

    await session.start({
      agent: new voice.Agent({ instructions: "Route the caller's transcript to the Sara backend." }),
      room: ctx.room,
      inputOptions: { textEnabled: false },
      outputOptions: { transcriptionEnabled: false },
      record: false,
    });
  },
});

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (["dev", "start"].includes(process.argv[2] ?? "")) voiceConfig();
  cli.runApp(new ServerOptions({
    agent: import.meta.filename,
    agentName: "sara",
    wsURL: process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880",
    apiKey: process.env.LIVEKIT_API_KEY ?? "devkey",
    apiSecret: process.env.LIVEKIT_API_SECRET ?? "secret",
    numIdleProcesses: 1,
  }));
}
