# Sara v1: text chat harness (TypeScript + Pi, voice-ready)

## Guiding principle
The model handles warmth, phrasing, intent and language mixing. Code handles numbers, facts, memory writes, ordering and cancellation. Every finance number Sara states comes from either the EMI tool or a dated knowledge-base record.

## Tech stack
- **Runtime:** Node 24 LTS, TypeScript, pnpm, `tsx` for dev. Node is not installed on this machine yet, so installing it is step one.
- **Server:** Hono with `@hono/node-server`. It serves the static page and has a built-in SSE helper (`streamSSE`).
- **Agent loop:** `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, with exact versions pinned because Pi is pre-1.0. The old `@mariozechner/*` scope stopped publishing in May 2026.
  - Tools are defined with TypeBox schemas. Streaming text and tool events map to SSE. Cancellation uses `AbortSignal`.
  - Pi's OpenAI Responses adapter sends `store: false` by default.
- **Models:** model IDs live in `.env`, so swapping one is a config change.
  - Chat turn: `gpt-6.1-terra`, reasoning `none`. Fall back to `gpt-6.2-sol` at `low` if it fails the Hinglish evals.
  - Memory extractor: `gpt-6-luna`, called through the official `openai` SDK with Structured Outputs and a zod schema. This one small call bypasses Pi.
- **Storage:** SQLite via `better-sqlite3`, WAL mode. SQLite is the source of truth, and there is one thread per user shared by every channel.
- **Finance grounding:** about 30 curated YAML records with fact, source URL, `effective_date` and `as_of`, validated with zod at boot and served by a lookup tool. No vector DB and no live web search.
- **Money math:** `decimal.js`.
- **UI:** one static `web/index.html` with vanilla JS, a user picker (no auth) and a memory side-panel for demo and debugging.
- **Tests and evals:** Vitest for unit checks, plus a `tsx` YAML conversation runner that writes a Markdown report.

## Architecture

```mermaid
flowchart LR
    UI[WebChat] -->|"POST message"| API[HonoServer]
    API --> Store[(SQLite)]
    API --> Coord[ThreadCoordinator]
    Coord -->|"debounce 1.5s, abort in-flight"| Engine[TurnEngine]
    Store -->|"rebuild context each turn"| Engine
    Engine --> Prompt[PromptBuilder]
    Prompt --> Mem[MemoryFacts]
    Prompt --> Lang[LanguagePolicy]
    Engine -->|"pi-agent-core loop"| LLM[OpenAI_Responses_via_pi_ai]
    LLM --> EMI[calculate_emi]
    LLM --> KB[lookup_finance]
    LLM --> Forget[forget_or_correct_memory]
    Engine -->|"Pi events to SSE"| UI
    Engine -->|"commit if generation current"| Store
    Engine -->|"after commit"| Extract[MemoryExtractor_openai_sdk]
    Extract --> Store
    Voice[FutureVoiceAdapter] -.->|"final transcript, channel=voice"| Coord
```

**How Pi is used:**
- No long-lived `Agent` per user. Each turn builds a fresh Pi agent (or uses the lower-level loop) from SQLite: system prompt, the last 12 model-facing messages, and the tools.
- The coordinator owns an `AbortController` per generation.
- When a run ends, the engine persists the new assistant and tool messages in one transaction, but only if its generation ID is still current.
- This keeps text and voice from drifting apart and makes a "forget" take effect immediately.

**The voice seam:** `TurnEngine.run({ userId, channel, utterances, signal }): AsyncIterable<SaraEvent>` is the only entry point. `channel` selects a style overlay: text allows ₹ symbols and numerals, while voice will use spoken numbers and no symbols.

## Repo layout
- [src/server.ts](src/server.ts): routes `POST /api/users/:uid/messages`, `GET /api/users/:uid/events` (SSE), `GET /api/users/:uid/history`, `GET /api/users/:uid/memories`. Also serves `web/`.
- [src/engine/coordinator.ts](src/engine/coordinator.ts): one reply task per thread with debounce, AbortController and a generation ID.
- [src/engine/turn.ts](src/engine/turn.ts): Pi loop wiring and mapping Pi events to `SaraEvent`.
- [src/engine/prompt.ts](src/engine/prompt.ts): persona, channel style overlay, memory injection, history window.
- [src/engine/language.ts](src/engine/language.ts): script detection and the reply-language directive.
- [src/memory/store.ts](src/memory/store.ts) and [src/memory/extractor.ts](src/memory/extractor.ts).
- [src/tools/emi.ts](src/tools/emi.ts), [src/tools/financeKb.ts](src/tools/financeKb.ts), [src/tools/memoryTool.ts](src/tools/memoryTool.ts), with data in [kb/finance.yaml](kb/finance.yaml).
- [src/db.ts](src/db.ts): schema and migrations.
- [web/index.html](web/index.html).
- [evals/conversations.yaml](evals/conversations.yaml), [evals/run.ts](evals/run.ts), `evals/reports/`.
- [test/](test/), [docs/design-note.md](docs/design-note.md), [decisions.md](decisions.md).

## Phases (about 9 of the 12 hours; the rest is reserved for voice later)

### Phase 0: Scaffold (0.5h)
- Install Node 24 and pnpm. Set up `tsconfig`, pinned Pi versions and `.env.example`.
- Record decision #1 (Pi) in `decisions.md`, including why we rebuild context per turn.
- Schema:
  - `users(id)`
  - `messages(id, user_id, role, channel, content, model_json, client_message_id UNIQUE, generation_id, status, created_at)`. `model_json` is the Pi message, with tool calls and results, used for exact replay.
  - `memories(id, user_id, key, fact, category, source_message_id, status active|superseded|deleted, updated_at)`

### Phase 1: Core turn plus chat UI (2h)
- First, a 20-minute spike: one Pi turn with a tool call, persist `model_json`, then replay it with `store: false` on `gpt-6.1-terra`. Confirm tool-call IDs and reasoning items round-trip. This is the main Pi risk.
- Persona prompt: friend first; 1 to 3 short sentences; no lectures; money only when the user raises it or sounds under pressure; never says "ask your CA".
- Cap output tokens at around 120.
- SSE events: `typing`, `delta`, `done`, `cancelled`, each tagged with `generationId`. User messages are persisted before the model is called.
- Minimal chat page that resumes history on reload.

### Phase 2: Finance accuracy (1.5h)
- `calculate_emi({ principal, annualRatePct, tenureMonths })`:
  - Uses `decimal.js`, with \(EMI = Pr/(1-(1+r)^{-n})\) and \(P/n\) when the rate is 0%.
  - Rounds half-up to paise.
  - If an input is missing, Sara asks for it instead of guessing.
- Vitest vectors:
  - ₹5,00,000 at 12% for 36 months gives ₹16,607.15.
  - ₹1,00,000 at 0% for 12 months gives ₹8,333.33.
  - ₹1,00,000 at 12% for 12 months gives ₹8,884.88.
- `lookup_finance({ topicIds })` over about 30 YAML records covering MUDRA tiers (including Tarun Plus), PMEGP, CGTMSE, GST thresholds, composition scheme, GST 2.0 rates (5/18/40 from 22 Sep 2025), GSTR-1/3B dates, Rule 46 invoice fields, e-invoice thresholds, and CIBIL range, free report and disputes.
- Prompt rule: regulatory numbers come only from tool results. If no record matches, Sara says honestly that she doesn't have the exact current number, shares what she does know, and gives a concrete way to check (for example, the lender's Key Facts Statement).
- Runtime guard: log a warning when a reply contains a ₹ amount or % that appears in neither the tool outputs nor the user's text. The eval reuses the same check.

### Phase 3: Memory (1.5h)
- Injection: active facts as a "what you know about them" block, plus the history window.
- Implicit facts: after each committed turn, a background extractor call proposes `add`, `update` or `delete` operations keyed by fact `key`. It uses the `openai` SDK with a zod schema. The server validates and applies them, keeping one active row per key. Corrections supersede the previous row. Results tied to an older message than the latest forget are rejected.
- Explicit "forget X" or "actually...": a synchronous `forget_or_correct_memory` Pi tool runs inside the turn, so Sara's "done" is true when she says it.
  - Forget is a hard delete of the fact value, including superseded rows.
  - Matching old messages are excluded from future context.

### Phase 4: Language and messy messaging (1h)
- Language:
  - Unicode check for Devanagari (U+0900 to U+097F), plus a small list of romanised-Hindi markers. This produces a directive: mirror the user's latest substantive message.
  - Short messages like "ok" or an emoji fall back to the previous language.
  - An explicit "always reply in Hindi" is stored as a sticky `language_pref` memory.
- Bursts:
  - 1.5s trailing debounce.
  - A new message during a reply calls `abort()`, waits for the run to settle, discards the draft (the UI drops the partial bubble) and regenerates against all unanswered messages.
  - Generation IDs stop stale events and late commits.
  - `client_message_id` deduplicates retries.

### Phase 5: Evals and two tuning rounds (2h)
- About 12 YAML conversations across English, Devanagari Hindi and Hinglish. They cover:
  - recall after a detour or a new session
  - correcting a fact, then forget-and-probe
  - switching English to Hindi to Hinglish
  - the three EMI vectors, plus EMI with the tenure missing
  - a knowledge-base fact (GST threshold)
  - honesty outside the knowledge base (a specific bank's rate)
  - a three-message burst, and a message sent mid-reply
  - a stressed user, where Sara should be friend first and then offer one practical step
- Deterministic checks:
  - EMI exact to the paisa
  - 3 sentences or fewer, splitting on `.`, `?`, `!` and `।`
  - script matches the expected language
  - banned phrases absent
  - memory state and recall
  - no ungrounded numbers
- LLM-judge checks (pass/fail with a quoted excerpt): tone, natural mixing, friend first.
- Output goes to `evals/reports/round1.md` and `round2.md`, with what changed between them.
- Optional, enabled by Pi: run the Hinglish subset against a second provider by changing config, and report the difference in the design note.

### Phase 6: Docs (0.5h)
- README covering clone to a running chat in under 10 minutes (`pnpm i && pnpm dev`).
- Design note draft covering:
  - how a turn flows
  - how the channels stay one Sara
  - what Sara trusts the model with and what she doesn't
  - what we'd change with more time

### Later (not now): Voice, staying in TypeScript
- LiveKit Agents for Node (WebRTC rooms and a browser starter). STT is Sarvam Saaras v4 in codemix mode, through the LiveKit Sarvam plugin or the `sarvamai` JS SDK. The same `TurnEngine` runs with `channel=voice`, and TTS is Sarvam Bulbul v4.
- Pipecat is ruled out because its server side is Python-only.
- Add per-stage latency timestamps, barge-in that reuses the coordinator's abort path, and silence or "hello?" handling.

## Trust split (for the design note)
- **Trusted to the model:** empathy, small talk, deciding when money is relevant, intent and argument extraction for tools, distinguishing Hinglish from Hindi, phrasing.
- **Enforced in code:**
  - EMI arithmetic
  - regulatory facts (knowledge base with dates)
  - memory writes and forget
  - message ordering, dedup and cancellation
  - output token cap
  - language directive
  - ungrounded-number detection
