# Sara memory experiment

Similarity search reduced the median voice prompt by 55% with 80 saved facts. Median time from transcript to first voiced audio was essentially flat. With eight saved facts, the prompt grew and audio started 141 ms later in the median trial.

## Setup

The baseline was commit `66aed54`, which sends all active facts to the reply model. Both versions used Ollama `qwen3.5:9b` on an Apple M5 Pro with 24 GB RAM. The experiment used `qwen3-embedding:0.6b`, normalized cosine similarity with a 0.42 minimum, and a five-fact cap. Each arm used its own temporary SQLite database containing the same synthetic facts. Original conversations were cleared from the fixtures so the model had to use memory. The context follow-up and topic-switch cases added two recent messages. [Qwen embedding model](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)

## Prompt size and time to first audio

Each row summarizes nine warm voice turns per arm, with three repetitions each in English, Hindi, and Hinglish. Prompt size is the first request's provider-reported input token count, including instructions, history, and tool definitions. The clock starts with the transcript available to the turn engine and stops at the first voiced PCM frame from Sara's macOS TTS adapter.

| Active facts | Median input tokens, baseline → similarity | Median first text, baseline → similarity | Median first audio, baseline → similarity |
| ---: | ---: | ---: | ---: |
| 8 | 1,271 → 1,392 (+9.5%) | 98 → 132 ms | 1,029 → 1,170 ms |
| 80 | 3,109 → 1,392 (−55.2%) | 96 → 113 ms | 1,149 → 1,141 ms |

Median retrieval time was 54 ms with eight facts and 57 ms with 80. The stored vectors indexed in 141 ms and 1,236 ms, respectively, before the timed runs. Cache reuse, model output length, and speech synthesis all affect first audio. With 80 facts, the baseline ranged from 900 to 2,900 ms and similarity ranged from 916 to 1,644 ms. The eight-millisecond difference between medians was small relative to that variation.

A separate LiveKit run used synthetic microphone input, Whisper, and macOS TTS with 80 saved facts. Across five warmed calls per arm, the median from the end of the utterance to client-received voiced audio was 3,602 ms for full memory and 3,007 ms for similarity. The runs ranged from 2,132 to 5,587 ms and 2,089 to 4,717 ms, respectively. The sample included three English calls, one Hindi call, and one Hinglish call per arm. Whisper misheard two English inputs in the similarity arm and both Hinglish inputs. The app's replies still referred to the intended city. The observed timing difference is sensitive to speech recognition and synthesis in this sample.

## Recall

| Check | Baseline | Similarity search |
| --- | ---: | ---: |
| Target fact available to the model | 22/22 | 22/22 |
| Reply matched the expected answer spelling or a listed variant | 21/22 | 20/22 |
| Unrelated prompts with zero saved facts supplied | 0/4 | 4/4 |

The two distinct Hinglish questions, one voice and one chat, recovered the intended fact across all seven runs. The context follow-up “And what is it called?” retrieved the shop name using the previous exchange. The broad shop question asked about six details, and similarity supplied five. The baseline answered all six. On an unrelated moon question, the baseline brought up the user's shop and balcony lights. The similarity prompt supplied zero facts.

The answer check matches expected names and cities by pattern. It flagged Hindi spellings of `Anvi` in both arms and one spelling of `Nashik` in the similarity arm. A similarity reply also mentioned the wrong city alongside the right one and passed the pattern check. The Hindi chat answer switched to first person despite being given the correct fact. Retrieval therefore scored better than exact delivery of the facts in replies.

An independent retrieval-only holdout used 18 different facts and 27 prompts. The target appeared in the top five for 6/6 English, 6/6 Hindi, and 4/6 Hinglish queries. Eight of nine unrelated prompts returned zero facts. A generic greeting retrieved one weak match. The two Hinglish misses were paraphrases about a shop name and a supplier. Median retrieval time was 30 ms.

Live write checks covered English, Hindi, and Hinglish. Hindi and Hinglish corrections used the existing key and stored English fact text, preserving names such as `नीम महल` and `nOOK&Co.`. One integrated check followed a Hindi correction with Hinglish voice-channel recall and a Hinglish forget request. The confirmation omitted the name, the active row was removed, and a later English probe reported no saved shop name. The checked-in tests cover delayed extraction after a forget, per-user isolation, zero and five matches, reopening SQLite, and replacement during indexing. Opening a database created by the baseline retained its history and facts.

The reply prompt uses only the retrieved fact list. Background extraction still sees active facts to match existing keys. Existing rows gain vectors on demand. On a cold model or after a provider failure, a turn may proceed with zero facts while indexing continues. Hosted embedding and speech providers were outside this benchmark.

## Two versus four preceding messages

The follow-up experiment compared two and four preceding user or assistant messages, each with the current message embedded separately. It used the same local embedding model, scoring weights, threshold, and 18-fact holdout. All 27 original probes selected exactly the same facts in both arms because their histories contained at most two messages.

| Check on 15 additional probes with four-message histories | Two messages | Four messages |
| --- | ---: | ---: |
| Follow-up target in the top five | 6/9 | 9/9 |
| Follow-up target ranked first | 2/9 | 5/9 |
| Unrelated topic switches with zero facts | 6/6 | 6/6 |
| Median retrieval time | 54 ms | 61 ms |

The wider window recovered the shop name after an intervening exchange in English, Hindi, and Hinglish. After the user switched from talking about their shop to their sister, four messages also retrieved the old shop-name fact at a lower rank in all three languages. Four preceding messages became the default for chat and voice retrieval.

A paired voice replay used 80 saved facts and identical reply history in both arms. It ran four scenarios three times per window, alternating arm order. Time to first audio runs from the transcript being available to the first voiced PCM frame from macOS TTS.

| Voice replay check | Two messages | Four messages |
| --- | ---: | ---: |
| Target fact retrieved | 6/9 | 9/9 |
| Reply matched the expected answer pattern | 4/9 | 7/9 |
| Unrelated topic switches with zero facts | 3/3 | 3/3 |
| Median provider input tokens | 1,348.5 | 1,394.5 |
| Median retrieval time | 87 ms | 93 ms |
| Median transcript to first audio | 1,432 ms | 1,161.5 ms |

The English follow-up accounted for all three additional answer matches. The Hindi follow-up retrieved the intended city in both arms, yet replies sometimes misread the reference or rendered the city differently from the expected pattern. With four messages, it also retrieved additional shop details. The first-audio result reflects changed reply wording and synthesis times in a small set of scenarios. The retrieval stage itself took six milliseconds more at the median.

## Reproduce

With the models pulled and Ollama running, run `pnpm check:memory` from the repository root. It outputs per-turn JSON with selected keys, prompt size, timing, and responses. Set `SARA_BENCH_SELECTION_ONLY=1` for retrieval-only results or `SARA_BENCH_AUDIO=off` for a comparison without macOS speech. The default baseline is `66aed54` and can be set with `SARA_BENCH_BASELINE`.

Run `node --env-file-if-exists=.env --import tsx scripts/memory-holdout.ts` for the independent retrieval fixture. Add `--compare-context` to compare the two context windows.

Run `SARA_BENCH_CONTEXT_PAIR=1 pnpm check:memory` for the paired voice replay.
