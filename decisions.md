# Decision journal - llms do not touch 

## Decision 1 — Use the Vercel AI SDK for the turn engine

I initially chose Pi for its extension hooks and configurable agent loop. 

ran out of time, and realized that Pi was kind of overkill for the current scope of the assignment. a simple agentic loop handrolled is more than enough. went ahead with vercel agent sdk since it provides most of the glue code we need for calling llms, switching providers etc. 


## Decision 2 - grounded answers for finance

the assignment specifically mentions that answers related to financial questions must be accurate, and emi calculation must be correct. 

emi calculation is trivial, a simple tool can be used for getting the right answer every time. in a production usecase this tool can be extended to handle different kinds of loan schemes.
rough idea but perhaps we can also allow our agent to create a tool for specific usecases on a per user basis, later on. 

finance grounding - we need to have a source of truth, it could be a collection of resources we index for the agent to access and query. i could think of two kinds of approaches, one where the agent performs lookup itself either using a subagent that searches through our collection or using a simple rag lookup/multihop retrieval. 


## Decision 3 - long term memory

although we have existing sophesticated libraries for long term memory like mem0, I experimented with a very simple memory implementation. 
each user interaction goes through a separate memory update/delete/create API call, which manages the user's memories.
retrieval of this memory is another challenge 
    -> option 1 : we show all the memories per turn - much simpler implementation and works when we have a bounded memory size of a small number of tokens
    -> option 2 : we have 2 layers of memories - one that the agent must know at all times, and is visible to every llm call. layer 2 is a semantic match of the current conversation context with the existing layer 2 memories. 

    this would work pretty well in theory but add some latency to the voice agent. if i had more time i would try to optimize this kind of approach. 

## Decision 4 - voice agent

livekit seems to provide the glue code we need for our voice agent. i experimented with different free/local models (supertonic, sarvam, whisper stt) and latencies , along with silero VAD. achieving proper hinglish output with these small models seemed to be tough. single language works decent but if the conversation gets longer the output quality is not great. but this could also be because im relying on locally running Qwen 9b for the LLM which is pretty weak as an agentic model.  