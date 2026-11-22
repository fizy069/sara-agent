import {
  type APIConnectOptions,
  APIStatusError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  tts,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { randomUUID } from "node:crypto";

const sampleRate = 24_000;
const model = "bulbul:v4-flash";
const defaultSpeaker = "ishita_enhi_customer";

export class SarvamTTS extends tts.TTS {
  label = "sara.sarvam";

  constructor(
    private readonly apiKey: string,
    private readonly speaker = defaultSpeaker,
  ) {
    // LiveKit buffers sentences; each HTTP response streams audio as it is generated.
    super(sampleRate, 1, { streaming: false });
  }

  get model() { return model; }
  get provider() { return "sarvam"; }

  stream(): tts.SynthesizeStream {
    throw new Error("Sarvam HTTP speech uses LiveKit's sentence TTS adapter.");
  }

  synthesize(text: string, options = DEFAULT_API_CONNECT_OPTIONS, signal?: AbortSignal) {
    // A retry after partial audio would repeat words and could bill the same text twice.
    const stream = new SarvamSpeechStream(text, this, { ...options, maxRetry: 0 }, signal, this.apiKey, this.speaker);
    if (signal?.aborted) stream.close();
    return stream;
  }
}

class SarvamSpeechStream extends tts.ChunkedStream {
  label = "sara.sarvam";

  constructor(
    text: string,
    tts: SarvamTTS,
    options: APIConnectOptions,
    signal: AbortSignal | undefined,
    private readonly apiKey: string,
    private readonly speaker: string,
  ) {
    super(text, tts, options, signal);
  }

  protected async run(): Promise<void> {
    const text = this.inputText.trim();
    if (!text || this.abortSignal.aborted) return;

    try {
      const response = await fetch("https://api.sarvam.ai/text-to-speech/stream", {
        method: "POST",
        headers: { "api-subscription-key": this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model,
          speaker: this.speaker,
          language_code: "en-IN",
          speech_sample_rate: sampleRate,
          output_audio_codec: "linear16",
          enable_preprocessing: true,
        }),
        signal: AbortSignal.any([this.abortSignal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new APIStatusError({
          message: `Sarvam speech synthesis returned HTTP ${response.status}.`,
          options: { statusCode: response.status },
        });
      }
      if (!response.body || response.headers.get("content-type")?.split(";")[0] !== "audio/pcm") {
        await response.body?.cancel();
        throw new Error("Sarvam speech synthesis did not return PCM audio.");
      }

      const requestId = randomUUID();
      const audio = new AudioByteStream(sampleRate, 1, sampleRate / 50);
      let pending: AudioFrame | undefined;
      const push = (frame: AudioFrame) => {
        if (pending) this.queue.put({ requestId, segmentId: requestId, frame: pending, final: false });
        pending = frame;
      };
      for await (const chunk of response.body) {
        if (this.abortSignal.aborted) return;
        for (const frame of audio.write(chunk)) push(frame);
      }
      if (this.abortSignal.aborted) return;
      for (const frame of audio.flush()) push(frame);
      if (!pending) throw new Error("Sarvam speech synthesis returned no audio.");
      this.queue.put({ requestId, segmentId: requestId, frame: pending, final: true });
    } catch (error) {
      if (!this.abortSignal.aborted) throw error;
    }
  }
}
