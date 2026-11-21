# Sara

Sara is a text companion for people who run small businesses in India. She streams replies through the Vercel AI SDK, calculates loan EMIs, and keeps separate chat history and memory for each demo user in SQLite.

## Run locally with Ollama

Use Node.js 24 and pnpm 11.25.0. The SQLite driver builds from source and needs Python and a C++ toolchain. On macOS, the Xcode Command Line Tools provide the compiler.

Install [Ollama](https://ollama.com/download) and open it, or run `ollama serve` in a separate terminal if the server isn't already running. From the repository root, run these commands.

```sh
ollama pull qwen3.5:9b
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

The browser demo currently supports text chat. The finance lookup is a stub and returns no verified records.

### Switch to OpenAI

When you have a key, set `SARA_MODEL_PROVIDER=openai` and `OPENAI_API_KEY` in `.env`, clear any Ollama model overrides, then restart Sara. Chat defaults to `gpt-6.1-terra` and memory extraction defaults to `gpt-6-luna`. You can override either with `SARA_CHAT_MODEL` or `SARA_MEMORY_MODEL`. Switching providers uses the same SQLite database.

If your database predates the AI SDK migration, you can start with a fresh database by setting `SARA_DB_PATH=data/sara-ai-sdk.sqlite`.

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check the TypeScript source. |
| `pnpm build` | Compile the server to `dist/`. |
| `pnpm start` | Run the compiled server after building it. |
| `pnpm test` | Run the offline turn-engine checks. |
| `pnpm check:replay` | Use the configured chat model to verify that a follow-up can use a tool result after reopening a temporary SQLite database. |

See the [v1 plan](docs/v1-plan.md) for the remaining phases.
