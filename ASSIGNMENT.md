# Interview Assignment: Sara Chat + Voice Agent

## Context

You will build a small version of Sara, an AI companion for people who run small businesses in India. Sara talks on WhatsApp-style text and on live voice calls, in English, Hindi and Hinglish.

Sara is a friend first and a finance expert second. She chats about the person's day, trade and family, and goes to money (loans, GST, invoices, credit reports) when they ask or sound under pressure. She replies like a person texting: one to three short sentences, specific, never a lecture.

The hard part is not calling a model. It is keeping one coherent person across two channels: the same memory, the same language, the same thread of conversation, whether the user types or talks, and fast enough that a call feels like a call.

## The task

Build one backend with two front doors: a text chat (Part A) and a voice call (Part B). Sara must be the same person on both: what she knows, how she talks, and where the conversation stands.

We care more about your design and judgement than about UI. One simple web page with the chat and a call button is enough.

## Part A: chat agent

Users reach Sara through a web chat UI that you build. The API behind it is yours to design.

What a good Sara does in chat. How you get there is up to you.

- She sounds like a person, not a help desk. Decide what that means for length, tone and when to bring up money.
- She speaks the user's language. English, Hindi or Hinglish. Real users mix languages; decide when Sara should switch and when she should not.
- She remembers. A user who told her about their shop and their daughter's wedding last week should not have to say it again. People also correct themselves, and ask her to forget things.
- She is right about money. Finance answers come from sources you choose and can stand behind. She does not make up rates, limits or dates, and she does not brush the user off to someone else ("ask your CA").
- She copes with how people really message. Three messages in a row, or a new one while she is still replying.
- She does one calculation: the EMI on a loan. The number must be right every time.

In your design note, tell us which of these you trust the model to do and which you do not, and why.  

Out of scope for Part A: WhatsApp integration, authentication, documents and images, multi-step workflows.

## Part B: voice agent

Users can also call Sara from a browser. Pick your own real-time and speech stack; it has to cope with Indian English, Hindi and Hinglish.

- It is the same Sara. What the user says on a call she knows in chat, and the other way round.
- It feels like a call. Decide what "fast enough" means, measure it, and show where the time goes.
- She sounds like speech, not a chat reply read aloud.
- Callers are messy. They interrupt, pause mid-sentence, say "hello?" into a silence, and call back later about something else. Sara should handle all of it gracefully.
- Part of this task is finding what breaks. Make test calls, list the problems you find, and fix the ones that matter most. Tell us what you left unfixed.

Out of scope for Part B: phone numbers and PSTN, the WhatsApp Calling API, voice notes.

## Deliverables

1. A Git repository with the chat harness, the voice call, the tests, and a README that gets us from clone to a running chat and call in under 10 minutes.
2. A design note of at most two pages: how a turn flows, how the two channels stay one Sara, and what you would change with more time.
3. Test conversations you write in English, Hindi and Hinglish, run through your build: what you checked, what passed, what failed. Two tuning rounds at most; we want to see what you measured, not a perfect score.
4. A latency report for the call.
5. A screen recording of at most 5 minutes: one chat, then one call that shows Sara remembers it.

## How we evaluate

We weigh judgement over polish. A build that does less but knows exactly what it guarantees beats one that only looks good in a demo.

## Timebox and follow-up

Plan for about 12 hours of work over 5 calendar days. The must-have outcome is a working chat harness: the backend that runs Sara's conversation turns, with the web chat on top, meeting Part A. The voice call builds on that harness. If you run short, cut from the voice call, never from the chat harness, and tell us what you cut and why.

If you finish early, pick the one improvement you think matters most for Sara and argue for it.

In a 60-minute follow-up you walk us through your build, and we change one requirement live.
