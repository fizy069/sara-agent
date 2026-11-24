import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioFrame } from "@livekit/rtc-node";
import { afterEach, expect, it, vi } from "vitest";
import { WhisperSTT } from "../src/voice/local-speech.js";

const endpoint = new URL("http://127.0.0.1:8090/inference");
const audio = new AudioFrame(new Int16Array(320), 16_000, 1, 320);

afterEach(() => vi.unstubAllGlobals());

it("sends WAV audio to the preloaded server and keeps silence handling", async () => {
  const fetch = vi.fn(async (url: URL, request: RequestInit) => {
    expect(url).toEqual(endpoint);
    expect(request.redirect).toBe("error");
    const form = request.body as FormData;
    expect(form.get("language")).toBe("auto");
    const wave = form.get("file") as File;
    expect(wave.type).toBe("audio/wav");
    expect(Buffer.from(await wave.arrayBuffer()).toString("ascii", 0, 4)).toBe("RIFF");
    return Response.json({ text: "[silence]" });
  });
  vi.stubGlobal("fetch", fetch);
  const whisper = new WhisperSTT("unused-cli", "model.bin", endpoint);

  const result = await whisper.recognize(audio);
  expect(result.alternatives?.[0]?.text).toBe("");
  expect(fetch).toHaveBeenCalledOnce();
});

it("uses the existing CLI when the server response cannot be used", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: null })));
  const directory = await mkdtemp(join(tmpdir(), "sara-whisper-test-"));
  try {
    const executable = join(directory, "whisper-cli");
    await writeFile(executable, `#!/bin/sh
while [ "$1" != "--output-file" ]; do shift; done
printf '%s\\n' 'Local fallback.' > "$2.txt"
`, { mode: 0o700 });
    const whisper = new WhisperSTT(executable, "model.bin", endpoint);

    const result = await whisper.recognize(audio);
    expect(result.alternatives?.[0]?.text).toBe("Local fallback.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not start a fallback transcription when the caller cancels", async () => {
  const caller = new AbortController();
  const reason = new Error("caller cancelled");
  vi.stubGlobal("fetch", vi.fn(async () => {
    caller.abort(reason);
    throw reason;
  }));
  const whisper = new WhisperSTT("unused-cli", "model.bin", endpoint);

  await expect(whisper.recognize(audio, caller.signal)).rejects.toBe(reason);
});
