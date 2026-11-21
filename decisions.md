# Decision journal

## Decision 1 — Use the Vercel AI SDK for the turn engine

We initially chose Pi for its extension hooks and configurable agent loop. Sara’s guarantees for cancellation, generation IDs, commits, memory, grounding, and channel prompts are implemented in the application, so those extension points went unused.

The AI SDK streams chat replies, runs tools, and extracts memory as structured output. Model IDs can change through configuration, and switching providers starts with the model factory in `src/engine/models.ts`. For example, adding Gemini would require the `@ai-sdk/google` adapter and a `SARA_CHAT_PROVIDER` setting wired into the factory.

SQLite stores only text, tool-call, and tool-result parts. Provider metadata and reasoning are omitted, so switching providers requires no database migration.

The migration was estimated at about two hours and requires resetting the development database. The AI SDK and OpenAI adapter are both pinned to exact versions to manage breaking API changes.
