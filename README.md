# Sara

Sara is a text companion for people who run small businesses in India. The current build streams replies through Pi and saves a separate chat history for each demo user in SQLite.

## Run locally

Use Node.js 24 and pnpm 11.25.0. The SQLite driver builds from source and needs Python and a C++ toolchain. On macOS, the Xcode Command Line Tools provide the compiler.

From the repository root, install the dependencies and copy the example configuration.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env` to a key with access to the default model, `gpt-6.1-terra`. Start the server.

```sh
pnpm dev
```

Open [Sara on localhost](http://127.0.0.1:3000), choose a demo user, and send a message. Reload to resume that user's conversation. The server creates `data/sara.sqlite` on startup.

## Development commands

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check the TypeScript source. |
| `pnpm build` | Compile the server to `dist/`. |
| `pnpm start` | Run the compiled server after building it. |
| `pnpm spike:replay` | Use the configured OpenAI endpoint to exercise a tool call and replay its saved Pi messages after reopening a temporary SQLite database. |

See the [v1 plan](docs/v1-plan.md) for the remaining phases.
