# Decisions

## 1. Use Pi for the agent loop

We considered writing the loop ourselves, using a framework such as the OpenAI Agents SDK or LangGraph, and configuring an existing harness such as OpenCode. Pi gives us a small, extensible tool loop and streaming interface. We can adapt the core behavior for Sara without spending the timebox rebuilding provider and tool orchestration. Both Pi packages use the same exact release so their message and event interfaces stay in sync.

Each turn builds a fresh Pi context from SQLite. Text and voice can use the same saved conversation, and future memory corrections can take effect on the next turn. Storing Pi messages as JSON preserves tool calls, tool results, and provider metadata for stateless replay through the OpenAI Responses API. The coordinator can cancel a generation and discard its draft without leaving it in the next turn's context.
