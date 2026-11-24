import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type APIConnectOptions,
  type AudioBuffer,
  mergeFrames,
  normalizeLanguage,
  stt,
  tts,
} from "@livekit/agents";
import { AudioFrame, AudioResampler } from "@livekit/rtc-node";

const run = promisify(execFile);
const sttSampleRate = 16_000;
const ttsSampleRate = 24_000;
const devanagari = /\p{Script=Devanagari}/u;

function asWav(audio: AudioBuffer): Buffer<ArrayBuffer> {
  let frame = mergeFrames(audio);
  if (frame.sampleRate !== sttSampleRate) {
    const resampler = new AudioResampler(frame.sampleRate, sttSampleRate, frame.channels);
    try {
      frame = mergeFrames([...resampler.push(frame), ...resampler.flush()]);
    } finally {
      resampler.close();
    }
  }
  const data = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(frame.channels, 22);
  header.writeUInt32LE(sttSampleRate, 24);
  header.writeUInt32LE(sttSampleRate * frame.channels * 2, 28);
  header.writeUInt16LE(frame.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function wavPcm(wave: Buffer): Buffer {
  // macOS may add a FLLR chunk to align the data, so the PCM does not start at byte 44.
  for (let offset = 12; offset + 8 <= wave.length;) {
    const length = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (wave.toString("ascii", offset, offset + 4) === "data" && length && start + length <= wave.length) {
      return wave.subarray(start, start + length);
    }
    offset = start + length + (length % 2);
  }
  throw new Error("macOS speech synthesis returned no PCM audio.");
}

export class WhisperSTT extends stt.STT {
  label: string;

  constructor(
    private readonly executable: string,
    private readonly modelPath: string,
    private readonly inferenceUrl?: URL,
  ) {
    super({ streaming: false, interimResults: false });
    this.label = inferenceUrl ? "sara.whisper-server" : "sara.whisper-cli";
  }

  stream(): stt.SpeechStream {
    throw new Error("Whisper CLI uses LiveKit's non-streaming STT adapter.");
  }

  protected async _recognize(audio: AudioBuffer, signal?: AbortSignal): Promise<stt.SpeechEvent> {
    const wav = asWav(audio);
    const serverText = await this.recognizeWithServer(wav, signal);
    const text = (serverText ?? await this.recognizeWithCli(wav, signal)).trim();
    const silence = !text || /^(?:\[[^\]]+\]|\([^)]*\)|\*[^*]*\*)$/.test(text);
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      requestId: randomUUID(),
      alternatives: [{
        text: silence ? "" : text,
        language: normalizeLanguage(devanagari.test(text) ? "hi" : "en"),
        startTime: 0,
        endTime: 0,
        confidence: 1,
      }],
    };
  }

  private async recognizeWithServer(wav: Buffer<ArrayBuffer>, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.inferenceUrl) return;
    signal?.throwIfAborted();
    try {
      const form = new FormData();
      form.set("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
      form.set("response_format", "json");
      form.set("language", "auto");
      const timeout = AbortSignal.timeout(2_000);
      const response = await fetch(this.inferenceUrl, {
        method: "POST", body: form, redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Whisper server returned HTTP ${response.status}.`);
      }
      const transcript = await response.json() as { text?: unknown } | null;
      if (typeof transcript?.text !== "string") throw new Error("Whisper server returned an invalid transcript.");
      return transcript.text;
    } catch {
      signal?.throwIfAborted();
      console.warn("Sara Whisper server unavailable, using Whisper CLI for this utterance.");
    }
  }

  private async recognizeWithCli(wav: Buffer, signal?: AbortSignal): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sara-stt-"));
    try {
      const input = join(dir, "input.wav");
      const output = join(dir, "transcript");
      await writeFile(input, wav, { signal });
      await run(this.executable, [
        "--model", this.modelPath, "--language", "auto", "--file", input,
        "--output-txt", "--output-file", output, "--no-prints",
      ], { signal, timeout: 30_000 });
      return await readFile(`${output}.txt`, { encoding: "utf8", signal });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export class MacTTS extends tts.TTS {
  label = "sara.macos-say";

  constructor() {
    super(ttsSampleRate, 1, { streaming: false });
  }

  stream(): tts.SynthesizeStream {
    throw new Error("macOS speech uses LiveKit's sentence TTS adapter.");
  }

  synthesize(text: string, options?: APIConnectOptions, signal?: AbortSignal) {
    return new MacSpeechStream(text, this, options, signal);
  }
}

class MacSpeechStream extends tts.ChunkedStream {
  label = "sara.macos-say";

  protected async run(): Promise<void> {
    const requestId = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), "sara-tts-"));
    try {
      const input = join(dir, "reply.txt");
      const output = join(dir, "reply.wav");
      const text = this.inputText.replace(/\[\[[\s\S]*?\]\]/g, "").trim();
      await writeFile(input, text, { signal: this.abortSignal });
      await run("/usr/bin/say", [
        "-v", "Tara", "--file-format=WAVE", `--data-format=LEI16@${ttsSampleRate}`,
        "-f", input, "-o", output,
      ], { signal: this.abortSignal, timeout: 10_000 });
      const pcm = wavPcm(await readFile(output));
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
      const frameSize = ttsSampleRate / 50;
      for (let offset = 0; offset < samples.length; offset += frameSize) {
        // LiveKit's native bridge reads from the start of the backing buffer.
        const data = samples.slice(offset, offset + frameSize);
        this.queue.put({
          requestId,
          segmentId: requestId,
          frame: new AudioFrame(data, ttsSampleRate, 1, data.length),
          final: offset + frameSize >= samples.length,
        });
      }
    } catch (error) {
      if (!this.abortSignal.aborted) throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
