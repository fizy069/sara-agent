## Sara design note

### How a turn flows

- In chat, the browser sends the typed message to the backend. On a call, LiveKit carries the audio, and the voice worker turns speech into text and sends it to the same backend.
- The backend saves the message and loads the user’s recent conversation and saved memories. The Vercel AI SDK sends that context to the model and streams the reply back as it’s written.
- Sara can call tools during a turn. She uses a calculator for loan EMIs and searches a small collection of trusted documents for finance questions.
- The browser shows the reply as it arrives. On a call, the voice worker also reads it aloud and can stop speaking if the caller interrupts.
- The backend saves the finished reply in SQLite. A separate step checks whether the user shared anything worth remembering and updates their saved memories.

### How chat and voice stay one Sara

- Both channels use the same turn engine, tools, and core instructions. Sara keeps the same personality and matches the user’s language. Voice replies are shorter and spell out numbers so they sound natural when spoken.
- Chat and calls use the same profile ID to load history and memory. If you tell Sara your shop’s name in chat, she can remember it on a call. What you say on the call also shows up in the same conversation.

### What I’d change with more time

- Improve how Sara hears and speaks Hinglish, especially on longer calls and when people interrupt.
- Keep the most important memories available every turn and look up other details when they’re relevant. Measure the effect on call response time.
- Let Sara search across several finance documents when one document can’t answer the whole question.


