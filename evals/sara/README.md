# Sara prompt evaluation

`prompts/v1.ts` is a snapshot of the Sara prompt as it stood when the eval was added. To try a proposed revision, copy it to `prompts/v2.ts` and edit the copy. Each version exports `buildPrompt` with the same signature as the production prompt builder.

Run manually when both versions are ready.

```sh
pnpm eval:sara --baseline v1 --candidate v2
```

The runner uses Sara's configured provider, chat model, reasoning, and context window. It starts each scripted conversation in a fresh in-memory SQLite database and commits completed turns so follow-ups can use their version's conversation history. The regular turn engine and tools run both versions. The grounded UPI case requires the local finance index with the NPCI source.

[`cases.ts`](cases.ts) defines the expected replies and tool behavior. The runner checks the completed tool calls and results, then sends the two conversations to the configured memory model (`SARA_MEMORY_MODEL`) as a single anonymized comparison per case. A pass requires both the code checks and the judge to pass. Read the replies and judge's reasons before deciding whether to adopt the candidate. Exit status 1 indicates an execution or judge error. The command reports behavior verdicts and leaves the live prompt file untouched.

Voice latency can be measured separately with the [voice benchmark](../../docs/latency-report.md).
