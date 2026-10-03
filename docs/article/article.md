---
pagetitle: "Extract a knowledge graph with a Jev-style decision model on Ollama"
author-meta: "Raphael MANSUY"
lang: en
---

# The problem, in one minute

Your company already knows a lot. It is written down in notes, tickets, wikis, and release posts. A person can read one page and answer "Who works where?" A computer cannot, because the facts are buried inside sentences.

> Jane Doe joined Acme Inc in Berlin. Acme Inc uses EdgeQuake. EdgeQuake depends on PostgreSQL.

A **knowledge graph** fixes that. It is a list of things (people, companies, products, places) and the links between them ("works at", "uses", "depends on"). Once the facts are in a graph, you can ask "Who works at Acme?" or "Which products depend on PostgreSQL?" and get the answer in a second, across a thousand files.

Pulling the things and the links out of the text is called **extraction**. It is the hard part.

![A note, and the same facts as a graph.](svg/problem.png)

# Why it is hard to do well today

There are five common ways to do it. Each one gives something up.

![Five ways to find names and links in text. The last row is the method in this article.](svg/landscape.png)

**Rules** (word lists and search patterns) are cheap, but they break the moment someone phrases a sentence differently. **Older trained tools** work well on the kind of text they were trained on, usually news, and badly on anything else. **Newer trained models** give the best scores, but only after someone labels thousands of examples for your topic.

The fourth way is the popular one: ask a **chat model** to write the answer as JSON, a tidy format that programs can read. It works on almost anything and takes ten minutes to try. The catch is easy to miss. A tidy answer is not a true answer. The model is still just writing the next word. It does not tell you how sure it is, so a guess looks exactly like a fact, and you end up reading every link yourself.

# The idea: ask small questions, get a number

A **decision model** is a small AI model that does not write. It answers one **closed question**. "Closed" means you decide what shape the answer can take before the model runs. There are three shapes.

![Three kinds of closed question. The technical names are in small print.](svg/question.png)

The answer always comes with a number between 0 and 1 that says how sure the model is.

::: keep
Here is a real call, with real output, from the model `tev1` running on one computer:

```
Question 1:  Does EdgeQuake use PostgreSQL?   ->  0.99   (very sure: yes)
Question 2:  Did Acme Inc found PostgreSQL?   ->  0.01   (very sure: no)

Time: 2.9 seconds.   Words written by the model: 3 tokens.
```
:::

A **token** is a small piece of text, about three-quarters of a word. For comparison, Mistral Small, a chat model, wrote about 250 tokens for each news sentence we gave it, because it writes out every link in full.

Two things to know before you trust the number. First, it is not an exact odds. A 0.9 does not mean "right nine times in ten". You have to check it against your own examples. Second, it needs the right tools. **Ollama** is a free program that runs AI models on your own computer. Since version 0.35 it has a special door for this kind of model, called `/v1/systemone`. We measured the models `tev1` and `nimble`. We have not tested `clef` or `clef-flash`.

![A decision model and a chat model with a JSON format are not the same thing.](svg/contract.png)

Forcing a chat model to output JSON makes the answer *well-formed*. It does not make it *true*, and it does not give you a number you can use as a cutoff.

# How edgextract works

edgextract is a small Python library. You give it a markdown file and a list. It gives you a graph. The list is called an **ontology**: you write down the kinds of thing you care about (person, company, place) and which links are allowed between them (a person can *work for* a company, a company cannot *work for* a place).

The tool works in six steps, shown in the figure below on one sentence: "EdgeQuake depends on PostgreSQL." Three ideas hold the design together.

- **The code finds, the model only judges.** Names come from your list and from markdown clues, such as bold text. The model is asked about a name only when the code has never seen it.
- **Your list shrinks the questions.** It says a product can *use* or *depend on* a technology. It says nothing about a place depending on a person, so that pair is never asked. This is why the tool cannot invent a kind of link.
- **Each link is its own question.** "Uses" and "depends on" can both be true, so each gets its own yes-or-no. Here the answers were 0.97 and 1.00.

![Six steps, with one sentence followed all the way through. Plain code finds, the model answers closed questions, your rule makes the final call.](svg/pipeline.png)

![A link is kept when the model is sure, sent to a person when it is not, and dropped when the answer is no.](svg/gate.png)

In the default setting a yes at 0.80 or higher is kept, a no at 0.20 or lower is dropped, and everything in between waits for a person as a plain sentence. These cutoffs are your code's, not the model's. They start as sensible guesses and are not fitted to your data. Fit them on your own examples before you rely on them.

![A few of the links the software-documentation list allows. The full list has seven kinds of link.](svg/ontology.png)

The model never finds a name by itself and never invents a kind. It only answers the questions the code asks.

# Write your own list in ten minutes

The same software works on any topic. A second list ships with it for company news: people, companies, and places, with links such as *founded*, *acquired*, *invested in*, and *works for*.

```
edgextract init-ontology my_list.yaml        # writes a starter file with comments
edgextract validate-ontology my_list.yaml    # prints your kinds and links in plain words
edgextract --model tev1 report note.md --ontology my_list.yaml --out graph.html
```

Or from Python:

```
from edgextract import extract_text, load_ontology_named, write_report

text = open("note.md").read()
ontology = load_ontology_named("company_news")
result = extract_text(text, ontology, model="tev1")
write_report("graph.html", text, result, ontology, title="My note")
```

# What we measured

Every number here was produced on one computer on 3 October 2026. The commands are in the repository. Most results below use a **score** between 0 and 1. It goes up when the tool finds the right items, and down when it keeps wrong ones. 1.00 is a perfect match with the answer key. We also give raw counts, because they are easier to understand than a score.

## One short software note

We took a seven-sentence note about EdgeQuake and compared four ways of doing the job. The names on this note are on the list, so a perfect name score here only shows that lookup works.

| Method | Names | Links | Seconds |
|---|---|---|---|
| `tev1`, one yes-or-no per link | 1.00 | 0.78 | 7.9 |
| `nimble`, the same questions | 1.00 | 0.38 | 19.0 |
| Mistral Small, JSON (hosted service) | 0.89 | 0.80 | 3.5 |
| `gemma4`, JSON (same computer) | 0.95 | 0.89 | 77.8 |

![Seconds to process one note. The hosted model is the fastest. Among models on your own computer, the decision models are far faster.](svg/speed.png)

Read this fairly. On a single note, a chat model matched or beat the decision model on links. The decision model's advantage here is speed against a chat model on the same computer, plus the numbers and the review list. A hosted service is fast too, but it sends your text out and charges for every token.

## Twelve software notes

We also ran both methods on the 12 hand-labeled software notes that ship with the repository. They include awkward cases on purpose: a note with no facts, a negation ("X does not use Y"), a code fence, a hedge, pronouns, and text that tries to give the model orders.

| Method | Names score | Links score | Right links | Wrong links | Seconds, all 12 |
|---|---|---|---|---|---|
| edgextract with `tev1` | 0.97 | 0.59 | 11 of 18 | 8 | 12.7 |
| Mistral Small, JSON | 0.68 | 0.43 | 10 of 18 | 19 | 22.1 |

On two company-news notes both methods found all 10 names and 6 of 6 links, each with one extra link.

Treat this as a sanity check, not a fair contest. We used these notes while building the tool, and the tool finds names by lookup and markdown clues, which helps it here. Chat-model answers also change from run to run: an earlier run of Mistral Small scored 0.80 on names and 0.38 on links on the same notes. The `tev1` figure for seconds is with the model already loaded; the first call is slower.

## A public news test

**CoNLL04** is a well-known set of news sentences that researchers use to compare tools. People marked every name and link by hand. We used the 288 sentences set aside for testing. None of the names were given to the tool in advance, so it had to find them. A name counts only if the exact words and the kind are right. A link counts only if both names and the type are right. The answer key has 1,079 names and 422 links.

| Method | Names score | Links score | Right links found | Wrong links kept |
|---|---|---|---|---|
| A model trained on this test's training sentences (SpERT) | 0.89 | 0.71 | not measured here | not measured here |
| edgextract with `tev1`, final run | 0.69 | 0.39 | 154 | 218 |
| edgextract with `tev1`, first run | 0.66 | 0.41 | 155 | 177 |
| Mistral Small, JSON | 0.64 | 0.33 | 183 | 504 |

![Scores on the news test. The trained model has seen this kind of text before; the others have not.](svg/benchmark.png)

Here is the fair reading.

- **A trained model still wins.** If you have labeled examples in your own domain, train a model. That is the right tool for the job and we say so.
- **Against a chat model, the decision model keeps far fewer wrong links.** In the final run it kept 218 wrong links where Mistral Small kept 504, while finding 154 right ones against 183. It gives up a little recall to avoid a lot of noise.
- **We ran it twice and report both.** The first run used a small name-finding model. For the second we switched to a larger one and changed to one question per link. The larger finder helped with names (correct names went from 634 to 683). It did not help with links: the score slipped from 0.41 to 0.39, and reversed links went from 9 to 16. On the development sentences the change had looked better, so the gain did not carry over to the test. We kept the final run as the number of record and did not pick the better-looking one.
- **The test was opened twice, once per configuration.** The development sentences were used for all tuning.
- **`gemma4` has no news-test score.** We started it through Ollama, stopped after about ten sentences when we moved the comparison to Mistral Small, and do not count that partial run.

## What it costs to run

| | Decision model on your computer | Chat model on a hosted service |
|---|---|---|
| Money | Your own hardware, no per-token bill | Charged per token |
| Where your text goes | Stays on your computer | Sent to the provider |
| Speed on the news test | Seconds per sentence | 1.8 seconds per sentence |
| Wrong links kept (news test) | 218 | 504 |
| What it does with an unsure answer | Puts it in a review list | Keeps it |
| New topic | Edit the list | Rewrite the prompt and hope |

# Where it gets things wrong

The tool makes mistakes, and the number does not always warn you.

- **Direction.** On the EdgeQuake note it kept both "Ollama uses Nimble" (0.97, which is right) and the reversed "Nimble uses Ollama" (0.91, which is wrong). A confident number can be confidently wrong.
- **Look-alike links.** In the Northwind sample it kept "Acme Inc acquired Northwind", but the text says Acme *invested in* it. That one is wrong, and it is still in the sample graph in this repository on purpose.
- **Extra links.** It also kept "Jane Doe is part of Acme Inc" at 0.96, which the answer key does not contain.
- **One sentence at a time.** Links across sentences are not joined, and pronouns such as "she" or "it" are skipped.
- **It needs Ollama 0.35 or newer** and a decision model on your computer.

The review list helps, but it cannot catch a mistake the model is sure about. Treat the graph as a strong first draft, not a finished fact base.

# See the graph

Every run can write one self-contained web page, with no internet needed. It shows the text with the names highlighted, the links written as plain sentences, the items waiting for a person, and a graph you can move. Drag a name, scroll to zoom, click a name to read its links, hover a line to read the sentence behind it. Dashed amber lines are waiting for a person.

![The interactive graph from a real run on a short company-news note. One of the five links (Acme acquired Northwind) is wrong.](../img/graph.png){.shot}

![Unsure items wait as plain sentences. A person keeps or drops each one.](svg/review.png)

```
edgextract --model tev1 report note.md --ontology company_news --out graph.html
```

# Which one should you use

![Pick the tool that fits what you have. All three are reasonable.](svg/choose.png)

# Try it

```
git clone https://github.com/raphaelmansuy/edgextract && cd edgextract
uv sync --all-extras
ollama pull tev1
edgextract probe --model tev1
edgextract --model tev1 report data/golden/docs/13_northwind.md --ontology company_news --out graph.html
make test examples      # no model needed: uses a stand-in
```

Nine short examples teach one idea each. The full evaluation, with every number and the command that produced it, is in `specs/0001-implementation/14-evaluation.md`.

<div class="closing">
<p class="big">The cutoff is yours.</p>
<p>Refit it when the model, the wording, or your list changes.</p>
<p>Written by <strong>Raphael MANSUY</strong> &middot; <a href="https://www.linkedin.com/in/raphaelmansuy/">linkedin.com/in/raphaelmansuy</a></p>
</div>
