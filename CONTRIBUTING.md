# Contributing

Thanks for helping. The library is small on purpose. A good change keeps it that way.

## Set up

```bash
uv sync --all-extras
make lint test xref examples
```

None of that needs a model. Tests and examples use an in-process fake of `POST /v1/systemone`.

To run against a real model:

```bash
ollama pull tev1
uv run edgextract probe --model tev1
make test-live
```

## Rules that stay

- **No shape-rule heuristics.** Do not add regexes that decide a name's kind or a link's truth. Code proposes. The decision model decides.
- **Thresholds live in code.** `GateConfig.fitted` is false until someone fits it on labeled data. Do not claim the cutoffs are calibrated.
- **Every published number is reproducible by a command.** If you add a number to the README or the article, add the command that produced it to `specs/0001-implementation/14-evaluation.md`.
- **A closed decision is not a JSON coat on a chat model.** Keep the two apart in code and in words.

## Adding an ontology

```bash
uv run edgextract init-ontology data/ontology/my_domain.yaml
uv run edgextract validate-ontology data/ontology/my_domain.yaml
```

Add one or two golden documents in `data/golden/docs/` and their labels in `data/golden/labels/`, plus a test that loads the file and checks that the legal pairs are not empty. See `tests/test_ontology.py`.

## Pull requests

- Small and focused.
- `make lint test xref examples` is green.
- Say what you measured and how, in plain words.
