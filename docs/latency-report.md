# Sara voice latency benchmark

**Measured 22 November 2026.** The median wait from the end of the caller's speech to the first audible reply was 3.91 s with fully local speech, 3.30 s with Sarvam synthesis, and 2.51 s with Sarvam transcription and synthesis.

## Test setup

The benchmark used the `codex/sarvam-hinglish-tts` checkout at `7819fad` with the working-copy conversation token budget of approximately 2,048 tokens. All three setups used the same warm Ollama Qwen 3.5 9B model on the same Mac, with LiveKit and Silero voice activity detection. The minimum endpointing delay was 650 ms. Local speech used multilingual Whisper Small Q5 and macOS `say`. Sarvam speech used Saaras v3 in code-mix mode for transcription and Bulbul v4 Flash with Ishita for synthesis. The Sarvam synthesis setups also used the branch's Hinglish reply prompt. [Voice worker](../src/voice/worker.ts) · [Speech setup](../README.md#make-a-browser-call-on-macos)

An isolated LiveKit stack replayed the same synthetic microphone recordings in two five-turn calls per setup. Each call included an English opening about a slow day at a stationery shop, a Hindi stock-counting question, a Hinglish UPI payment-status question, an English EMI calculation, and a follow-up that changed the loan term from 12 to 24 months. The clock ran from the end of each input recording to the first or last voiced frame received by the LiveKit test client. The existing demos stayed running.

## Measured latency

Each setup contributed ten turns. Values are medians except where the table gives the observed range. Each stage and total has its own median, so the displayed stage medians can sum to a different value from the total median. Scenario medians use two repeats each, with four turns in the combined EMI row.

| Measurement | Whisper + macOS speech | Whisper + Sarvam voice | Sarvam transcription + voice |
| --- | ---: | ---: | ---: |
| **Speech end to first audible reply** | **3.91 s** | **3.30 s** | **2.51 s** |
| Observed range | 2.85–4.62 s | 2.23–3.49 s | 1.94–2.93 s |
| Speech end to final transcript, including end-of-turn detection | 1.28 s | 1.28 s | 0.88 s |
| Final transcript to Sara backend request | 2 ms | 2 ms | 5 ms |
| Backend request to first reply text from Qwen | 0.62 s | 0.67 s | 0.29 s |
| First reply text to start of synthesis | 0.41 s | 0.53 s | 0.47 s |
| Synthesis request to first audio chunk | 0.94 s | 0.33 s | 0.31 s |
| First audio chunk to first voiced frame received by the client | 68 ms | 73 ms | 68 ms |
| Speech end to **end of the spoken reply** | 13.83 s | 17.17 s | 13.44 s |
| English opening to first audio | 3.14 s | 2.83 s | 2.09 s |
| Hindi inventory question to first audio | 3.98 s | 3.11 s | 2.51 s |
| Hinglish payment question to first audio | 3.70 s | 3.12 s | 2.16 s |
| EMI question and follow-up to first audio | 4.15 s | 3.32 s | 2.83 s |

## Observations

- **Transcription.** Whisper processing itself took 0.60 s with macOS synthesis and 0.59 s with Sarvam synthesis at the median. The caller also waited for endpointing before local transcription started. Saaras began transcribing while the caller spoke.
- **API timing.** Sara's local HTTP endpoint returned headers in 3–24 ms across the runs. The synthesis row includes the Sarvam HTTP wait where applicable. End-of-reply timing also includes the length of Sara's spoken answer.
- **EMI tool.** Across eight timed calculator calls in the Sarvam voice setups, Qwen took about 1 s to issue the call. The calculation took 0–3 ms, and Qwen took another 0.16–0.17 s to start the answer.
- **Cold start.** One separate Ollama load took 4.26 s. The table reflects warmed-model calls.
- **Conversation quality.** Saaras preserved “payment status” and transcribed “UPI” as “UFIA” on both Hinglish repeats. Both Sarvam voice setups returned the exact EMI in the reply text on all four EMI turns. The fully local setup did so on one of four turns. The latency medians include these misses.

The observed ranges describe this small set of synthetic calls. The measurement ends at the LiveKit receiver on the same Mac. Browser playout and delays on a remote caller's network require separate measurements.

## Preloaded Whisper follow-up

**Measured 22 November 2026.** A loopback-only `whisper-server` kept the same Whisper Small Q5 model loaded across utterances. It used automatic language detection and matched the CLI's four threads, beam size of five, and best-of setting of five. Server startup to readiness took 162–778 ms across three runs, with a median of 189 ms. The first transcription after the third startup took 245 ms.

| Measurement | Fresh CLI per utterance | Preloaded Whisper |
| --- | ---: | ---: |
| Standalone transcription, median (observed range) | 416 ms (330–933 ms) | 193 ms (172–756 ms) |
| In-call transcription stage, median | 0.69 s | 0.56 s |
| In-call speech end to final transcript, median | 1.39 s | 1.22 s |
| In-call speech end to first audible reply, median (observed range) | 3.72 s (2.91–4.51 s) | 3.58 s (2.66–4.08 s) |

The standalone test ran three pairs per clip across the same five recordings. The median savings within a pair was 176 ms, and all 15 pairs produced matching transcripts after whitespace normalization. Standalone timing includes the CLI process or loopback HTTP round trip.

The LiveKit comparison used two three-turn calls per setup, replaying the English, Hindi, and Hinglish conversational clips with warm Qwen and macOS synthesis. Whisper still waited for endpointing before transcribing. The median caller wait fell by about 0.14 s across these calls, with variation in Qwen and speech synthesis between runs. The test used an isolated copy of the voice worker and a temporary Whisper server.

## Streaming Whisper at 650 ms and 500 ms

**Measured 22 November 2026.** Four isolated LiveKit configurations used the same preloaded Whisper Small Q5 model, warm Qwen, and macOS voices. The batch control decoded once after Silero signaled the end of speech. The streaming prototype decoded successive snapshots of the current utterance while audio arrived and reused the latest transcript if its audio covered at least 128 ms beyond the last frame Silero marked as speech. Otherwise, it decoded the complete utterance. Silero's silence threshold was 400 ms in all four configurations so LiveKit could apply either endpointing delay.

| Whisper mode | LiveKit minimum | Speech end to final transcript | Speech end to first audible reply (range) | Split the 575 ms pause |
| --- | ---: | ---: | ---: | ---: |
| Preloaded batch | 650 ms | 1.21 s | 3.22 s (2.34–4.88 s) | 0/2 |
| Streaming prototype | 650 ms | 0.98 s | 3.35 s (2.27–3.84 s) | 0/2 |
| Preloaded batch | 500 ms | 1.07 s | 2.76 s (2.56–3.60 s) | 2/2 |
| Streaming prototype | 500 ms | 1.13 s | 2.90 s (2.23–3.14 s) | 2/2 |

Latency columns show medians over six ordinary turns per configuration, using the same English, Hindi, and Hinglish recordings in two calls. Two separate pause probes per configuration inserted 575 ms of silence into an English sentence. Split counts come from the number of user turns recorded in Sara's history. Whisper misheard parts of the probe across configurations.

At 650 ms, streaming cut the median time to final transcript by about 0.24 s. The caller's median wait for first audio was about 0.14 s longer. The median time from Qwen's first text to the start of synthesis was 0.87 s with streaming and 0.54 s with batch as the generated replies varied. At 500 ms, streaming was slower than batch on both measured latency medians. It reused a preview for 11 of 12 ordinary streaming turns, issuing 5–10 preview decodes per turn. The sum of the Whisper request times had a median of 2.93–3.18 s per streaming turn, much of it overlapping the caller's speech.

## Preloaded Whisper worker

**Measured 25 November 2026.** Two isolated LiveKit calls each replayed the original five synthetic microphone fixtures with warm Qwen, Tara synthesis, and a 650 ms endpointing minimum. Both transcription arms used Whisper Small Q5 with automatic language detection, four threads, a beam size of five, and a best-of setting of five. In one arm Sara invoked the CLI for each turn. In the other, Sara sent the same type of WAV input to a loopback-only `whisper-server` with the model already loaded. The input fixtures were trimmed at the last sample exceeding the test's speech threshold. The receiver measured the first voiced frame on the same Mac.

| Stage | Whisper CLI | Preloaded server |
| --- | ---: | ---: |
| Transcription itself | 731 ms | 329 ms |
| End of caller speech to final transcript | 1,386 ms | 1,015 ms |
| Backend request to first reply text | 908 ms | 348 ms |
| First reply text to start of synthesis | 394 ms | 378 ms |
| Synthesis request to first audio chunk | 1,333 ms | 1,496 ms |
| First audio chunk to first voiced frame at receiver | 73 ms | 64 ms |
| **End of caller speech to first audible reply** | **4,135 ms (2,920–5,171)** | **3,863 ms (2,815–4,451)** |

Values are medians over five turns per arm. The warmed server became reachable 414 ms after launching. Qwen took 5,223 ms to load on a separate cold start. In these local calls, waiting for the final transcript and waiting for Tara's initial audio contributed most of the delay. Qwen's first text also varied between the calls. The end-to-end difference includes all of these effects.

Each arm saved one transcript for each turn. LiveKit transcripts varied across replays, with errors in both arms on the Hindi and Hinglish clips. Both arms answered the 24-month EMI follow-up correctly in text and missed the exact amount for 12 months. In a separate CPU-only control, both Whisper paths received byte-identical WAV files. They produced matching transcripts after whitespace normalization in all ten pairs. [Local Whisper setup](../README.md#keep-the-local-whisper-model-loaded)

## Bulbul HTTP and WebSocket synthesis

**Measured 25 November 2026.** A direct Sarvam test used the same Bulbul v4 Flash model, Ishita voice, Indian English language setting, preprocessing, and 24 kHz PCM for each transport. It replayed four two-sentence English replies about shop inventory, a UPI payment and two EMI amounts at 34 ms per word. Each transport saw the same replies in two interleaved passes. HTTP sent complete sentences and reused its HTTP connection when available. The WebSocket opened at the start of each reply and sent text every three words, then flushed at the end. The clock ran from the start of text generation to the first PCM chunk containing a sample above the test's voice threshold.

| Transport | Median | Range | Trials |
| --- | ---: | ---: | ---: |
| HTTP streaming | 1,061 ms | 807–2,260 ms | 8 |
| WebSocket, 50-character buffer | 1,254 ms | 1,031–1,745 ms | 8 |
| WebSocket, 100-character buffer | 1,685 ms | 1,227–2,381 ms | 8 |

The HTTP path had the lowest median for these replies. The test captures synthesis under a simulated text stream. Measuring a WebSocket connection reused across turns and caller wait through the full voice pipeline requires another test. [Sarvam WebSocket guide](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket)

## Local end-of-turn model pause probe

**Measured 25 November 2026.** The LiveKit v1-mini audio model scored the last two seconds of the five completed English, Hindi and Hinglish fixtures and the incomplete English phrase “Can you help me with”. The test repeated each clip with 300, 400, 500, 575 and 650 ms of appended silence. All five completed fixtures exceeded the packaged threshold at every delay. The incomplete phrase also exceeded it at every delay, including a score of 0.960 at 575 ms against the 0.250 English threshold. Across all 30 predictions, model inference took 63 ms at the median (51–70 ms).

This was an offline scoring probe on synthetic clips. The earlier LiveKit test split both 575 ms pauses at a 500 ms fixed minimum. Sara keeps the 650 ms minimum while this accuracy risk remains. [LiveKit turn detector guide](https://docs.livekit.io/agents/logic/turns/turn-detector/)
