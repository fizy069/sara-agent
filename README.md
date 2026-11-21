# Sara

Sara is a chat and voice companion for people who run small businesses in India. She streams replies through the Vercel AI SDK, calculates loan EMIs, and shares history and memory between chat and calls for each demo user in SQLite.

## Run locally with Ollama

Use Node.js 24 and pnpm 11.25.0. The SQLite driver builds from source and needs Python and a C++ toolchain. On macOS, the Xcode Command Line Tools provide the compiler.

Install [Ollama](https://ollama.com/download) and open it, or run `ollama serve` in a separate terminal if the server isn't already running. From the repository root, run these commands.

```sh
ollama pull qwen3.5:9b
ollama pull qwen3-embedding:0.6b
pnpm install --frozen-lockfile
pnpm dev
```

Without an OpenAI key, Sara defaults to local `qwen3.5:9b` for chat and memory extraction. For custom settings, copy [.env.example](.env.example) to `.env`. If you already have a `.env` from the OpenAI setup, set `SARA_MODEL_PROVIDER=ollama` and remove any `SARA_CHAT_MODEL` and `SARA_MEMORY_MODEL` entries that point to OpenAI.

Open [Sara on localhost](http://127.0.0.1:3000), choose a demo user, and send a message. The first reply can take longer while Ollama loads the model. The server creates `data/sara.sqlite` on startup, and the conversation resumes when you reload the page.

### Try Sara

1. Send “Aaj dukaan mein kaafi rush tha.” for a Hinglish reply.
2. Ask “What’s the monthly EMI on ₹1,00,000 at 12% annual interest for 12 months?” to try the calculator. The expected result is ₹8,884.88.
3. Send “I run a stationery shop in Pune.” Open **Memory** and wait for the shop details to appear. Then ask “Please forget where my shop is.”

When you ask Sara to forget a fact, she removes its stored values and hides the related conversation turns from future model context. The chat transcript remains visible in the demo.

Sara stores new and corrected facts in English and keeps names in the spelling and script you give her. She searches the current user's active SQLite facts using multilingual embeddings of the current message and up to four preceding messages from the user or Sara. The reply prompt receives up to five sufficiently similar facts. The Memory panel still shows all active facts. Existing facts stay in the database and gain embeddings as Sara indexes them.

The finance lookup is a stub and returns no verified records.

## Make a browser call on macOS

The local path uses LiveKit for audio, Whisper for transcription, macOS voices for speech, and the same Ollama model as chat. Install the audio tools and download a multilingual Whisper model from the repository root. [LiveKit local setup](https://docs.livekit.io/transport/self-hosting/local/), [Whisper model files](https://github.com/ggml-org/whisper.cpp/tree/master/models).

```sh
brew install livekit whisper.cpp
mkdir -p data/models
curl -fL https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin \
  -o data/models/ggml-small-q5_1.bin
```

Copy [.env.example](.env.example) to `.env` if needed and add these settings. Generate a value for the shared token with `openssl rand -hex 24`.

```dotenv
SARA_AGENT_TOKEN=replace-with-a-random-token
SARA_WHISPER_MODEL=data/models/ggml-small-q5_1.bin
```

Keep Ollama running. Run `livekit-server --dev`, `pnpm dev`, and `pnpm voice:dev` in separate terminals. Open [Sara on localhost](http://127.0.0.1:3000), choose a demo user, click **Call Sara**, and allow microphone access. Use **End call** to hang up. The default LiveKit credentials and demo profiles are for local development.

1. In chat, tell Sara “My shop is called Lotus Stationery.”
2. Call from the same demo profile and ask “Do you remember the name of my shop?”
3. On the call, mention a new detail and hang up after Sara replies. Ask about it in chat. Look for **You · Voice** and **Sara · Voice** in the shared conversation.

For hosted speech, set `SARA_SPEECH_PROVIDER=sarvam` and `SARVAM_API_KEY` in the worker’s environment. LiveKit uses Sarvam for transcription and speech synthesis. Conversation and memory still use the backend’s configured Ollama or OpenAI models.

### Voice flow

The backend gives the browser a room-scoped token and dispatches the Sara worker. LiveKit detects speech and interruptions, and the worker sends the final transcript to the backend. The same coordinator handles typed and spoken turns. It streams the reply to both the browser transcript and the worker, which synthesizes audio into the room. If the caller interrupts while a reply is generating, the worker closes the reply stream and the backend cancels that generation. A reply that has already committed remains in history even if the caller interrupts playback.

The local worker transcribes after a pause and uses macOS speech voices. Short pauses can split a sentence, and Hinglish pronunciation depends on the selected system voice. The worker logs timing by stage for smoke testing.

The English and Hindi smoke scenarios verified recall across chat and voice. The English test also transcribes the audio received over LiveKit to check that the reply is intelligible. In a separate call, speaking over Sara stopped the first reply and started a new turn. Whisper garbled the new preference in the Hinglish sample, so that check failed.

One local smoke call used Whisper small and Qwen 3.5 9B. Times are in seconds.

| Measurement | Seconds |
| --- | ---: |
| End of test utterance to first voiced reply audio | 2.3 |
| Whisper transcription | 0.5 |
| Backend request to first token | 0.2 |
| First synthesis request to first PCM chunk | 0.7 |

### Switch to OpenAI

When you have a key, set `SARA_MODEL_PROVIDER=openai` and `OPENAI_API_KEY` in `.env`, clear any Ollama model overrides, then restart Sara. Chat defaults to `gpt-6.1-terra`, memory extraction to `gpt-6-luna`, and embeddings to `text-embedding-3-small`. You can override them with `SARA_CHAT_MODEL`, `SARA_MEMORY_MODEL`, and `SARA_EMBEDDING_MODEL`. Switching providers uses the same SQLite database and regenerates embeddings for the configured model.

If your database predates the AI SDK migration, you can start with a fresh database by setting `SARA_DB_PATH=data/sara-ai-sdk.sqlite`.

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check the TypeScript source. |
| `pnpm build` | Compile the server to `dist/`. |
| `pnpm start` | Run the compiled server after building it. |
| `pnpm voice:dev` | Run the LiveKit voice worker in development mode. |
| `pnpm voice:start` | Run the compiled voice worker after building it. |
| `pnpm test` | Run the offline turn-engine checks. |
| `pnpm check:memory` | Compare similarity-based memory with the full-memory baseline using temporary databases and the configured models. |
| `pnpm check:replay` | Use the configured chat model to verify that a follow-up can use a tool result after reopening a temporary SQLite database. |
| `pnpm check:voice` | Make a real LiveKit call with synthetic microphone audio and use local Whisper to check the returned speech. Requires the running stack and `SARA_WHISPER_MODEL`. |

See the [original v1 plan](docs/v1-plan.md) for the text harness and roadmap.

The [memory experiment report](docs/memory-experiment.md) compares multilingual recall, prompt size, and first-audio timing with the full-memory baseline.
