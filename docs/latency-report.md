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

## On-demand voice latency check

With the Sara backend, LiveKit, and the voice worker running, use `pnpm check:voice --latency`. The command reuses the smoke test's microphone replay and LiveKit receiver. It plays both clips once to warm the stack, then replays each clip five times. Each run starts a fresh call with an empty chat history. Keep the speech providers, voice, instance, and model settings fixed across runs and when comparing changes.

The fixtures are synthetic 16 kHz mono PCM WAVs. They use the macOS Tara voice and have been trimmed to remove trailing silence.

| Fixed clip | Spoken question |
| --- | --- |
| [Shop talk](../scripts/fixtures/voice/shop-talk.wav) | Hi Sara, how can I make a slow day at my shop more useful? |
| [Hinglish EMI](../scripts/fixtures/voice/emi-hinglish.wav) | For a one lakh rupee loan at twelve percent annual interest for twelve months, monthly EMI kitni hogi? |

The second clip gives all the inputs for `calculate_emi`. Use the printed transcript and reply to see whether the spoken question was heard and answered as intended.

The report shows the median, observed range, and count of first-audio timeouts after 60 seconds for each clip. Only the five measured runs contribute to the table. Setup or follow-up errors have a separate count. A measured first-frame timestamp still contributes if a later diagnostic fails. Any failed run makes the command exit nonzero after printing the report.

If a change increases latency, find its printed room name in the worker's `Sara voice timing` logs. Use the [stage breakdown above](#measured-latency) to compare end-of-turn detection and transcription, response generation, and speech synthesis.
