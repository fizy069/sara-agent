import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent,
  TrackKind, TrackPublishOptions, TrackSource, dispose,
} from "@livekit/rtc-node";

const exec = promisify(execFile);
const sampleRate = 16_000;
const frameSize = 320;
const origin = process.env.SARA_BACKEND_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const user = `voice-smoke-${randomUUID()}`;

async function request(path, body, method = body === undefined ? "GET" : "POST") {
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

async function chat(content) {
  await request("messages", { content, clientMessageId: randomUUID() });
}

async function messages() {
  return (await request("history")).messages;
}

async function memories() {
  return (await request("memories")).memories;
}

async function speechFixture(dir) {
  const aiff = join(dir, "caller.aiff");
  const wave = join(dir, "caller.wav");
  await exec("/usr/bin/say", [
    "-v", "Tara", "-o", aiff, "My favorite fruit is mango. Do you remember which city my shop is in?",
  ]);
  await exec("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wave]);
  const wav = await readFile(wave);
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString("ascii", offset, offset + 4) === "data") {
      const pcm = Int16Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(offset + 8 + 2 * i));
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

const dir = await mkdtemp(join(tmpdir(), "sara-voice-smoke-"));
const room = new Room();
let source;
let audio;
let audioReader;
let firstAudioAt;
let voicedFrames = 0;
let lastSpeechAt;

room.on(RoomEvent.TrackSubscribed, (track) => {
  if (track.kind !== TrackKind.KIND_AUDIO || audio) return;
  const reader = new AudioStream(track, { sampleRate, numChannels: 1 }).getReader();
  audio = reader;
  audioReader = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (lastSpeechAt === undefined || !value.data.some((sample) => Math.abs(sample) > 350)) continue;
      firstAudioAt ??= performance.now();
      voicedFrames++;
    }
  })();
});

try {
  const pcm = await speechFixture(dir);
  await chat("I run a stationery shop in Pune.");
  await until("initial chat reply", async () => (await messages()).some((msg) => msg.role === "assistant"));
  await until("Pune saved in chat memory", async () => (await memories()).some((item) => /pune/i.test(item.fact)));

  const { url, token } = await request("call", {});
  await room.connect(url, token);
  assert(room.localParticipant, "Caller did not join");
  source = new AudioSource(sampleRate, 1, 100);
  const mic = LocalAudioTrack.createAudioTrack("smoke-microphone", source);
  await room.localParticipant.publishTrack(mic, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  await until("agent audio subscription", () => audio, 15_000);
  await publish(source, new Int16Array(sampleRate / 2));
  await publish(source, pcm);
  lastSpeechAt = performance.now();
  await publish(source, new Int16Array(sampleRate * 2));

  const transcript = await until("user voice transcript", async () =>
    (await messages()).find((msg) => msg.channel === "voice" && msg.role === "user"));
  console.log(`Voice transcript: ${transcript.content}`);
  assert.match(transcript.content, /mango/i, "The shared thread should contain the spoken fact");
  const reply = await until("voice reply in shared history", async () =>
    (await messages()).find((msg) => msg.channel === "voice" && msg.role === "assistant"));
  console.log(`Voice reply: ${reply.content}`);
  assert.match(reply.content, /pune/i, "The voice reply should recall the city from chat");
  await until("audible voice reply in LiveKit", () => voicedFrames >= 15);
  console.log(`Received ${voicedFrames} voiced frames. Fixture end to first audible frame: ${Math.round(firstAudioAt - lastSpeechAt)} ms.`);

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
  await dispose();
  await rm(dir, { recursive: true, force: true });
}
