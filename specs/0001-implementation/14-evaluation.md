# 14 — Evaluation

**WHY.** A number that was not measured on this machine does not belong in the article. WHY-4.

This note is the full record of what we measured. The score used throughout is an F1. It is high only when the extractor finds the right items and does not invent many extras. 1.00 is a perfect match on that file. 0.50 means hits and misses are about even.

## Our own tech notes

Twelve short markdown files live in `data/golden/docs/`, with the expected names and links in `data/golden/labels/`. A name counts as correct when the canonical name and the kind match. A link counts as correct when both ends and the link type match.

On 3 October 2026 we scored the note `01_edgequake.md` on this machine.

The names in that note are already listed in the ontology, so finding them is a lookup. A perfect name score there does not show that the extractor can find a name it has never been given.

| How we decided | Names | Links | Time |
|---|---|---|---|
| Nimble, one yes-or-no per question, names looked up | 1.00 | 0.38 | 19.0 seconds |
| Tev1, same questions | 1.00 | 0.67 | 9.4 seconds |
| Tev1, one yes-or-no for each allowed link type | 1.00 | 0.78 | 7.9 seconds |
| A chat model (gemma4) writing JSON | 0.95 | 0.89 | 77.8 seconds |

The last Tev1 row is the current question shape. On that note it kept both “EdgeQuake uses PostgreSQL” and “EdgeQuake depends on PostgreSQL.” It missed the links from EdgeQuake to Apache AGE and to pgvector. It also kept two links that are not in the answer key: Jane Doe is part of Acme Inc, and Nimble uses Ollama (the direction is reversed).

## A public news benchmark

CoNLL04 is a standard set of news sentences with people, organizations, places, and a few other names, plus the links between them. We use the split published with the SpERT paper. The answer key is not our tech-docs list, and none of those names are pre-listed, so the extractor has to find the spans itself.

A span counts only when the exact characters and the kind are right. A link counts only when both spans and the link type are right. We also count two softer mistakes: the characters were right but the kind was wrong, and the link type was right but the direction was reversed.

A model trained on the CoNLL04 training sentences (SpERT) scores about 0.89 on names and 0.71 on links on the hidden test sentences. Our run does not train on those sentences. That published score is a ceiling, not a target we failed.

How we ran it:

1. Choose any cutoff on the development sentences only. Do not look at the test sentences while choosing.
2. Read the mistakes.
3. Change one thing that those mistakes justify, and measure the development sentences again.
4. Run the test sentences once and stop.

What the development mistakes said: the kind was rarely wrong (14 spans had the right characters and the wrong kind) and the direction was rarely reversed (4 links). The extractor mostly failed by missing names entirely (341 names absent). Lowering the span cutoff from 0.50 to 0.30 barely helped. Switching the span finder from the small model to the larger GLiNER2.5 Base model helped more.

| Run | Names found (precision / recall / F1) | Links (precision / recall / F1) | Right span, wrong kind | Reversed direction |
|---|---|---|---|---|
| Development, small span finder, cutoff 0.50 | 0.794 / 0.618 / 0.695 | 0.480 / 0.382 / 0.425 | 14 | 4 |
| Development, small span finder, cutoff 0.30 | 0.779 / 0.628 / 0.696 | 0.455 / 0.402 / 0.427 | 16 | 4 |
| Development, larger span finder, cutoff 0.30 | 0.797 / 0.663 / 0.724 | 0.465 / 0.461 / 0.463 | 15 | 11 |
| Test, small span finder, cutoff 0.30, once (first run) | 0.749 / 0.588 / 0.658 | 0.467 / 0.367 / 0.411 | 15 | 9 |
| Test, larger span finder, cutoff 0.30, one yes-or-no per link (final run) | 0.758 / 0.633 / 0.690 | 0.414 / 0.365 / 0.388 | 18 | 16 |

Precision is the share of our answers that were right. Recall is the share of the answer key that we found.

The first test run used the small span finder. It stopped at sentence 243 and was finished later from the same saved decisions, so it is still one pass.

The final run is the configuration the repository ships: the larger span finder (`fastino/gliner2.5-base-v1`) at cutoff 0.30 and one yes-or-no question per allowed link type. It was run once on the test split after the development runs above, with this command:

```bash
uv run edgextract --model tev1 --timeout 120 eval-benchmark --split test \
  --encoder-model fastino/gliner2.5-base-v1 --encoder-threshold 0.30 --device mps \
  --cache .edgextract-cache/conll04-test-base-t030.sqlite --out docs/results/conll04-test-tev1-final.json
```

Counts for the final run: names 683 right, 218 extra, 396 missed; links 154 right, 218 extra, 268 missed. Gold totals: 1,079 names, 422 links.

**How to read the two test runs.** The larger finder helped names (634 → 683 right) and did not help links. The link score fell from 0.411 to 0.388, and reversed links rose from 9 to 16. On the development sentences the same change had looked better (links 0.427 → 0.463), so that gain did not carry over to the test split. We report both runs and treat the final run as the number of record because it is the shipped configuration, not because it scored higher. On this benchmark each pair of kinds has only one legal link, so splitting links into one question each adds no extra questions here. It matters on the tech notes, where “uses” and “depends on” can both be true.

## The same test, with a chat model

Mistral Small (`mistral-small-latest`, called on Mistral’s API, not through Ollama) read each test sentence once and wrote JSON. A predicted name counts only when that exact wording occurs in the sentence and the kind matches. All 288 sentences returned parseable JSON. None were used to change the prompt. Mean time was 1.8 seconds a sentence.

| Method on the test sentences | Names (precision / recall / F1) | Links (precision / recall / F1) | Right span, wrong kind | Reversed direction |
|---|---|---|---|---|
| Tev1, larger span finder, cutoff 0.30 (final run) | 0.758 / 0.633 / 0.690 | 0.414 / 0.365 / 0.388 | 18 | 16 |
| Tev1, small span finder, cutoff 0.30 (first run) | 0.749 / 0.588 / 0.658 | 0.467 / 0.367 / 0.411 | 15 | 9 |
| Mistral Small, one JSON answer per sentence | 0.595 / 0.699 / 0.643 | 0.266 / 0.434 / 0.330 | 34 | 3 |

Mistral Small finds a larger share of the answer key. It also invents more. On names it kept 514 extras against 754 correct. On links it kept 504 extras against 183 correct, which is why the link score falls to 0.330. The closed method keeps fewer wrong links (218 in the final run, 177 in the first, against 504), and its link score is 0.388 in the final run and 0.411 in the first. A system trained on the CoNLL04 training sentences still sits far above both, at about 0.89 for names and 0.71 for links.

gemma4 through Ollama was started on this test split and stopped after about ten sentences. That partial run is not a test score.

## Twelve tech notes, both methods

Both methods were scored on 3 October 2026 over the twelve tech-docs notes in `data/golden/` and the two company-news notes, with `scripts/score_golden.py`. The scorer is the same name-and-kind match as the rest of this file (not exact character spans). We used these notes while building the tool, so treat them as a sanity check, not a held-out test.

```bash
uv run python scripts/score_golden.py --method closed --model tev1 --out docs/results/golden-tev1.json
uv run python scripts/score_golden.py --method chat --model mistral-small-latest \
  --base-url https://api.mistral.ai --out docs/results/golden-mistral-small.json
```

| Method (tech notes) | Names (precision / recall / F1) | Links (precision / recall / F1) | Right links | Extra links | Seconds, all 12 |
|---|---|---|---|---|---|
| Tev1, closed decisions | 0.977 / 0.955 / 0.966 | 0.579 / 0.611 / 0.595 | 11 of 18 | 8 | 12.7 |
| Mistral Small, JSON (this run) | 0.640 / 0.727 / 0.681 | 0.345 / 0.556 / 0.426 | 10 of 18 | 19 | 22.1 |
| Mistral Small, JSON (earlier run, same day) | 0.755 / 0.841 / 0.796 | 0.300 / 0.500 / 0.375 | 9 of 18 | 21 | not recorded |

The two Mistral runs differ because a chat model does not answer the same way twice. Tev1 seconds are with the model already loaded. Tev1’s high name score is partly by design: known names come from the ontology list and markdown cues. On the two company-news notes both methods found 10 of 10 names and 6 of 6 links, each with one extra link (names 1.00, links 0.923). Those two files are short and the names are listed.

Result files: `docs/results/golden-tev1.json`, `docs/results/golden-mistral-small.json`. The CoNLL04 summaries are `docs/results/conll04-test-*.json`.
