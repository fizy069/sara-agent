# Sara

Sara is a text companion for people who run small businesses in India. She streams replies through the Vercel AI SDK, calculates loan EMIs, and keeps separate chat history and memory for each demo user in SQLite.

## Run locally

Use Node.js 24 and pnpm 11.25.0. The SQLite driver builds from source and needs Python and a C++ toolchain. On macOS, the Xcode Command Line Tools provide the compiler.

From the repository root, install the dependencies and copy the example configuration.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env` to a key with access to `gpt-6.1-terra` for chat and `gpt-6-luna` for background memory extraction. You can override them with `SARA_CHAT_MODEL` and `SARA_MEMORY_MODEL`. Start the server.

```sh
pnpm dev
```

Open [Sara on localhost](http://127.0.0.1:3000), choose a demo user, and send a message. Reload to resume that user's conversation. The server creates `data/sara.sqlite` on startup.

If you used Sara before the AI SDK migration, stop the server and delete `data/sara.sqlite` before restarting. This resets your local chat history and memories.

Open **Memory** to see the selected user's saved facts. When you ask Sara to forget a fact, she removes its stored values and hides the related conversation turns from future model context. The chat transcript remains visible in the demo.

The finance lookup is currently a stub and returns no verified records. EMI calculations use the principal, annual rate, and tenure supplied in chat.

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check the TypeScript source. |
| `pnpm build` | Compile the server to `dist/`. |
| `pnpm start` | Run the compiled server after building it. |
| `pnpm test` | Run the offline turn-engine checks. |
| `pnpm check:replay` | Use the configured OpenAI model to verify that a follow-up can use a tool result after reopening a temporary SQLite database. |

See the [v1 plan](docs/v1-plan.md) for the remaining phases.
