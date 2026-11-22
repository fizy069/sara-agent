import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent,
  TrackKind, TrackPublishOptions, TrackSource, dispose,
} from "@livekit/rtc-node";

const exec = promisify(execFile);
const sampleRate = 16_000;
const frameSize = 320;
const firstReplyTimeoutMs = 60_000;
const measuredRuns = 5;
const origin = process.env.SARA_BACKEND_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const whisperBin = process.env.SARA_WHISPER_BIN ?? "whisper-cli";
const whisperModel = process.env.SARA_WHISPER_MODEL;
const { values: flags } = parseArgs({ options: { latency: { type: "boolean" }, help: { type: "boolean" } } });

async function request(user, path, body) {
  const method = body === undefined ? "GET" : "POST";
  const res = await fetch(new URL(`/api/users/${user}/${path}`, origin), {
    method,
    signal: AbortSignal.timeout(5_000),
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

async function until(description, get, timeoutMs = 60_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await get();
    if (result) return result;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function speechFixture(dir) {
  const aiff = join(dir, "caller.aiff");
  const wave = join(dir, "caller.wav");
  await exec("/usr/bin/say", [
    "-v", "Tara", "-o", aiff, "My favorite fruit is mango. Do you remember which city my shop is in?",
  ]);
  await exec("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wave]);
  return readSpeechFixture(wave);
}

async function readSpeechFixture(wave) {
  const wav = await readFile(wave);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF", "Expected a RIFF speech fixture");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE", "Expected a WAVE speech fixture");
  let validFormat = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const chunk = wav.toString("ascii", offset, offset + 4);
    const start = offset + 8;
    assert(start + size <= wav.length, "Speech fixture WAV has a truncated chunk");
    if (chunk === "fmt ") {
      validFormat = size >= 16 && wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1
        && wav.readUInt32LE(start + 4) === sampleRate && wav.readUInt16LE(start + 14) === 16;
    }
    if (chunk === "data") {
      assert(validFormat && size % 2 === 0, "Speech fixture must be 16 kHz mono 16-bit PCM");
      const pcm = Int16Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(start + 2 * i));
      assert(pcm.some((sample) => Math.abs(sample) > 1_000), "Speech fixture is silent");
      return pcm;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("Speech fixture WAV has no data chunk");
}

async function publish(source, pcm) {
  for (let i = 0; i < pcm.length; i += frameSize) {
    const samples = new Int16Array(frameSize);
    samples.set(pcm.subarray(i, i + frameSize));
    await source.captureFrame(new AudioFrame(samples, sampleRate, 1, frameSize));
  }
  await source.waitForPlayout();
}

async function transcribeReply(dir, frames) {
  const pcm = Buffer.concat(frames);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const wave = join(dir, "received.wav");
  const output = join(dir, "received");
  await writeFile(wave, Buffer.concat([header, pcm]));
  await exec(whisperBin, [
    "--model", whisperModel, "--language", "en", "--file", wave,
    "--output-txt", "--output-file", output, "--no-prints",
  ], { timeout: 30_000 });
  return (await readFile(`${output}.txt`, "utf8")).trim();
}

async function runCall(clip, label) {
  const user = `voice-${clip ? "latency" : "smoke"}-${randomUUID()}`;
  const dir = clip ? undefined : await mkdtemp(join(tmpdir(), "sara-voice-smoke-"));
  const room = new Room();
  const received = [];
  const firstAudio = Promise.withResolvers();
  let source;
  let agent;
  let audio;
  let audioReader;
  let firstAudioAt;
  let voicedFrames = 0;
  let lastSpeechAt;

  const chat = (content) => request(user, "messages", { content, clientMessageId: randomUUID() });
  const messages = async () => (await request(user, "history")).messages;
  const memories = async () => (await request(user, "memories")).memories;
  const voiceHistory = () => until("voice reply in shared history", async () => {
    const history = (await messages()).filter((msg) => msg.channel === "voice");
    return history.some((msg) => msg.role === "assistant") ? history : undefined;
  });

  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO || audio) return;
    agent = participant;
    const reader = new AudioStream(track, { sampleRate, numChannels: 1 }).getReader();
    audio = reader;
    audioReader = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (lastSpeechAt === undefined) continue;
        if (!clip) received.push(Buffer.copyBytesFrom(value.data));
        if (!value.data.some((sample) => Math.abs(sample) > 350)) continue;
        if (firstAudioAt === undefined) {
          firstAudioAt = performance.now();
          firstAudio.resolve(firstAudioAt);
        }
        voicedFrames++;
      }
    })();
  });

  try {
    const pcm = clip ?? await speechFixture(dir);
    if (!clip) {
      await chat("I run a stationery shop in Pune.");
      await until("initial chat reply", async () => (await messages()).some((msg) => msg.role === "assistant"));
      await until("Pune saved in chat memory", async () => (await memories()).some((item) => /pune/i.test(item.fact)));
    }

    const { url, token } = await request(user, "call", {});
    await room.connect(url, token);
    if (clip) console.log(`${label} in room ${room.name}`);
    assert(room.localParticipant, "Caller did not join");
    source = new AudioSource(sampleRate, 1, 100);
    const mic = LocalAudioTrack.createAudioTrack("smoke-microphone", source);
    await room.localParticipant.publishTrack(mic, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    await until("agent audio subscription", () => audio, 15_000);
    await publish(source, new Int16Array(sampleRate / 2));
    await publish(source, pcm);
    lastSpeechAt = performance.now();
    await publish(source, new Int16Array(sampleRate * 2));

    if (clip) {
      const timeout = new AbortController();
      const remaining = Math.max(0, lastSpeechAt + firstReplyTimeoutMs - performance.now());
      let frameAt;
      try {
        frameAt = await Promise.race([firstAudio.promise, sleep(remaining, undefined, { signal: timeout.signal })]);
      } finally {
        timeout.abort();
      }
      if (frameAt === undefined || frameAt - lastSpeechAt > firstReplyTimeoutMs) return { duration: null };

      const duration = frameAt - lastSpeechAt;
      try {
        const history = await voiceHistory();
        const transcript = history.find((msg) => msg.role === "user");
        const reply = history.find((msg) => msg.role === "assistant");
        console.log(`  Heard: ${transcript?.content ?? "(no transcript)"}`);
        console.log(`  Sara: ${reply.content}`);
        await until("Sara to finish speaking", () => agent.attributes["lk.agent.state"] === "listening", 30_000);
      } catch (error) {
        return { duration, error };
      }
      return { duration };
    }

    const transcript = await until("user voice transcript", async () =>
      (await messages()).find((msg) => msg.channel === "voice" && msg.role === "user"));
    console.log(`Voice transcript: ${transcript.content}`);
    assert.match(transcript.content, /mango/i, "The shared thread should contain the spoken fact");
    const reply = (await voiceHistory()).find((msg) => msg.role === "assistant");
    console.log(`Voice reply: ${reply.content}`);
    assert.match(reply.content, /pune/i, "The voice reply should recall the city from chat");
    await until("audible voice reply in LiveKit", () => voicedFrames >= 15);
    console.log(`Received ${voicedFrames} voiced frames. Fixture end to first audible frame: ${Math.round(firstAudioAt - lastSpeechAt)} ms.`);
    await until("Sara to finish speaking", () => agent.attributes["lk.agent.state"] === "listening", 30_000);
    await sleep(300); // allow the receiver to drain its jitter buffer
    const heard = await transcribeReply(dir, received);
    console.log(`Reply transcribed from received audio: ${heard}`);
    assert.match(heard, /\bpune\b/i, "Pune should be intelligible in the actual LiveKit audio");

    await until("mango saved in voice memory", async () => (await memories()).some((item) => /mango/i.test(item.fact)));
    await room.disconnect();
    await chat("What is my favorite fruit?");
    const followup = await until("chat reply after the call", async () =>
      (await messages()).filter((msg) => msg.channel === "text" && msg.role === "assistant")[1]);
    console.log(`Chat after the call: ${followup.content}`);
    assert.match(followup.content, /mango/i, "Chat should recall the fact spoken during the call");
    console.log("Passed: chat → voice → chat, shared saved memory, and audible LiveKit output.");
  } finally {
    await room.disconnect();
    await audio?.cancel();
    await audioReader;
    await source?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

async function runLatencyCheck() {
  const clips = await Promise.all(["shop-talk", "emi-hinglish"].map(async (name) => ({
    name,
    pcm: await readSpeechFixture(new URL(`./fixtures/voice/${name}.wav`, import.meta.url)),
    durations: [],
    timeouts: 0,
    errors: 0,
  })));
  let hadFailure = false;
  for (let run = 0; run <= measuredRuns; run++) {
    for (const clip of clips) {
      const label = `${clip.name} ${run ? `run ${run}/${measuredRuns}` : "warm-up"}`;
      try {
        const { duration, error } = await runCall(clip.pcm, label);
        if (duration === null) {
          console.error(`${label}: timed out after ${firstReplyTimeoutMs / 1000} s waiting for first voiced audio`);
          if (run) clip.timeouts++;
          hadFailure = true;
        } else {
          console.log(`${label}: ${Math.round(duration)} ms to first voiced audio`);
          if (run) clip.durations.push(duration);
        }
        if (error) throw error;
      } catch (error) {
        console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        if (run) clip.errors++;
        hadFailure = true;
      }
    }
  }

  console.log("Clip end to first voiced reply frame. Warm-ups excluded.");
  console.table(clips.map(({ name, durations, timeouts, errors }) => {
    const sorted = durations.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return {
      Clip: name,
      Samples: sorted.length,
      "Median (ms)": sorted.length ? Math.round(median) : "—",
      "Range (ms)": sorted.length ? `${Math.round(sorted[0])}–${Math.round(sorted.at(-1))}` : "—",
      Timeouts: timeouts,
      "Other errors": errors,
    };
  }));
  console.log("For stage timings, match each room to the worker's Sara voice timing logs and see docs/latency-report.md.");
  if (hadFailure) process.exitCode = 1;
}

if (flags.help) {
  console.log("Usage: pnpm check:voice [--latency]");
} else {
  try {
    if (flags.latency) await runLatencyCheck();
    else {
      assert(whisperModel, "Set SARA_WHISPER_MODEL to transcribe and check the received LiveKit audio.");
      await runCall();
    }
  } finally {
    await dispose();
  }
}
