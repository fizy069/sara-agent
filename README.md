# Sara

Sara is a chat and voice companion for people who run small businesses in India. She streams replies through the Vercel AI SDK, calculates loan EMIs, and shares history and memory between chat and calls for each demo user in SQLite.

## Run locally with Ollama

Use Node.js 24 and pnpm 11.25.0. The SQLite driver builds from source and needs Python and a C++ toolchain. On macOS, the Xcode Command Line Tools provide the compiler.

Install [Ollama](https://ollama.com/download) and open it, or run `ollama serve` in a separate terminal if the server isn't already running. From the repository root, run these commands.

```sh
ollama pull qwen3.5:9b
pnpm install --frozen-lockfile
pnpm dev
```

Without an OpenAI key, Sara defaults to local `qwen3.5:9b` for chat and memory extraction. For custom settings, copy [.env.example](.env.example) to `.env`. If you already have a `.env` from the OpenAI setup, set `SARA_MODEL_PROVIDER=ollama` and remove any `SARA_CHAT_MODEL` and `SARA_MEMORY_MODEL` entries that point to OpenAI.

Chat and voice use half of `SARA_CHAT_CONTEXT_WINDOW` for conversation context, or about 2,048 tokens with the 4,096-token default. Sara keeps recent exchanges verbatim, including their tool calls and results. When older exchanges no longer fit, the memory model folds excerpts into a short rolling summary saved in SQLite. If summarization fails, Sara replies using the context it already has. If the current message uses the whole budget, Sara sends it on its own. To change the target, set `SARA_CHAT_CONTEXT_WINDOW` to match the context allocated by Ollama in `ollama ps`. [Ollama context settings](https://docs.ollama.com/context-length).

Open [Sara on localhost](http://127.0.0.1:3000), choose a demo user, and send a message. The first reply can take longer while Ollama loads the model. The server creates `data/sara.sqlite` on startup, and the conversation resumes when you reload the page.

### Try Sara

1. Send “Aaj dukaan mein kaafi rush tha.” for a Hinglish reply.
2. Ask “What’s the monthly EMI on ₹1,00,000 at 12% annual interest for 12 months?” to try the calculator. The expected result is ₹8,884.88.
3. Send “I run a stationery shop in Pune.” Open **Memory** and wait for the shop details to appear. Then ask “Please forget where my shop is.”

When you ask Sara to forget a fact, she removes its stored values, hides the related conversation turns from future model context, and discards the current summary. The chat transcript remains visible in the demo. Clearing chat history also clears the summary.

### Finance lookup

With Ollama running, build the finance index once after installing dependencies. These commands also apply when OpenAI provides the chat model.

```sh
ollama pull qwen3-embedding:0.6b
pnpm finance:index
```

The indexer downloads the full article text of ten [source documents](src/finance/sources.ts), embeds each whole document once, and stores the text, source URL, and vector in `data/finance.sqlite`. The index includes HTML article bodies and tables. Linked attachments stay at the original source. Re-run `pnpm finance:index` to refresh the local copy. Set `SARA_FINANCE_DB_PATH` to use a different database file.

Chat and voice share this index. `lookup_finance` asks the model for an English query regardless of the user's language, then uses `sqlite-vec` to find the closest document by cosine similarity. It returns one whole document with its publisher and source URL when the match clears the threshold. Lookups use the local Ollama embedding endpoint and the saved index.

When the index exists, Sara warms the embedding model in the background at backend startup. Finance queries ask Ollama to keep it loaded indefinitely. Ollama can still evict it when another model needs the memory. [Ollama model loading](https://docs.ollama.com/faq#how-do-i-keep-a-model-loaded-in-memory-or-make-it-unload-immediately)

| Topic | Supported questions |
| --- | --- |
| MUDRA and term loans | PMMY tiers and Tarun Plus eligibility, and what to check in a Key Facts Statement, including APR and the repayment schedule |
| Udyam | Online MSME registration and how Aadhaar and PAN validation work on the portal |
| Credit reports | Getting a free CRIF High Mark report and where to raise a dispute about it |
| Digital payments | RBI's turnaround and compensation framework for failed transactions, including UPI transfers and merchant payments |
| GST | CBIC guidance on GST registration paperwork and basic e-invoicing and invoice reference numbers |
| Digital lending and complaints | RBI's directory of digital lending apps and the purpose of the RBI Ombudsman scheme |

For questions beyond these documents, such as a live lender rate or the status of a specific payment, Sara is instructed to give a concrete place to check. Try “Mera UPI transfer debit ho gaya, lekin receiver ko nahi mila. Ab kya?”

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

### Keep the local Whisper model loaded

To avoid loading the model for every utterance, run `whisper-server` in a separate terminal on the same Mac. Use the same model file as `SARA_WHISPER_MODEL` and match the CLI's decoding settings.

```sh
whisper-server --host 127.0.0.1 --port 8090 \
  --model data/models/ggml-small-q5_1.bin --language auto \
  --threads 4 --beam-size 5 --best-of 5
```

Set `SARA_WHISPER_SERVER_URL=http://127.0.0.1:8090` in `.env` and restart the voice worker. Keep the CLI and model installed. Sara retries an utterance with the CLI if the loopback server returns an error or takes more than two seconds. [Latency report](docs/latency-report.md#preloaded-whisper-qwen-and-sarvam-synthesis)

### Use Sarvam for voice replies

For the demo setup, start the preloaded Whisper server above and use local Ollama Qwen with Sarvam synthesis. Add these settings to `.env` and restart the backend and voice worker.

```dotenv
SARA_MODEL_PROVIDER=ollama
SARA_CHAT_MODEL=qwen3.5:9b
SARA_SPEECH_PROVIDER=local
SARA_WHISPER_SERVER_URL=http://127.0.0.1:8090
SARA_TTS_PROVIDER=sarvam
SARVAM_API_KEY=replace-with-your-key
```

Sara uses Bulbul v4 Flash with Ishita and the Indian English locale for synthesis. Set `SARVAM_TTS_SPEAKER=simran_enhi_customer` and restart the worker to try another voice. [Sarvam voice guide](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/best-practices#writing-text-for-natural-speech).

To use Sarvam for microphone transcription too, set `SARA_SPEECH_PROVIDER=sarvam`. Sarvam bills transcription separately. [Sarvam API pricing](https://www.sarvam.ai/api-pricing).

### Voice flow

The backend gives the browser a room-scoped token and dispatches the Sara worker. LiveKit detects speech and interruptions, and the worker sends the final transcript to the backend. The same coordinator handles typed and spoken turns. It streams the reply to both the browser transcript and the worker, which synthesizes audio into the room. If the caller interrupts while a reply is generating, the worker closes the reply stream and the backend cancels that generation. A reply that has already committed remains in history even if the caller interrupts playback.

Sara replies in English on calls, including when the caller speaks Hindi or Hinglish. Typed replies follow the language of the latest message. Whisper transcribes after a pause. The local-only setup uses macOS Tara for synthesis. Short pauses can split a sentence. The worker logs timing by stage for smoke testing.

The English and Hindi smoke scenarios verified recall across chat and voice. The English test also transcribes the audio received over LiveKit to check that the reply is intelligible. In a separate call, speaking over Sara stopped the first reply and started a new turn. Whisper garbled the new preference in the Hinglish sample, so that check failed.

In the 25 November 2026 benchmark, preloading Whisper lowered median transcription time from 631 ms to 273 ms. With warm Qwen 3.5 9B and Sarvam Bulbul v4 Flash in both setups, median time from speech end to first audible reply fell from 2.90 s to 2.72 s over ten turns per setup. [Latency report](docs/latency-report.md#preloaded-whisper-qwen-and-sarvam-synthesis)

### Switch to OpenAI

When you have a key, set `SARA_MODEL_PROVIDER=openai` and `OPENAI_API_KEY` in `.env`, clear any Ollama model overrides, then restart Sara. Chat defaults to `gpt-6.1-terra` and memory extraction defaults to `gpt-6-luna`. You can override either with `SARA_CHAT_MODEL` or `SARA_MEMORY_MODEL`. Switching providers uses the same SQLite database.

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
| `pnpm finance:index` | Download the source documents and rebuild the local vector index. Requires Ollama and the embedding model. |
| `pnpm check:replay` | Use the configured chat model to verify that a follow-up can use a tool result after reopening a temporary SQLite database. |
| `pnpm check:voice` | Make a real LiveKit call with synthetic microphone audio and use local Whisper to check the returned speech. Requires the running stack and `SARA_WHISPER_MODEL`. |

See the [original v1 plan](docs/v1-plan.md) for the text harness and roadmap.
