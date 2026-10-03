# Examples

Each script teaches one idea. Set `EDGEXTRACT_FAKE=1` to run without Ollama.

```bash
make examples
# or
PYTHONPATH=. EDGEXTRACT_FAKE=1 uv run python examples/01_hello_decision.py
```

Set `EDGEXTRACT_ONTOLOGY=company_news` to swap the bundled software-docs list for company news.

| File | What it teaches | What you should see |
|---|---|---|
| `01_hello_decision.py` | A closed Choice | A winner and a probability |
| `02_pick_a_label.py` | Yes-or-no and a scored level | A noul near 1.0 for a refund request |
| `03_type_a_name.py` | Looking up and typing names | `Jane Doe` as PERSON |
| `04_find_links.py` | One yes-or-no per legal link | `USES` and `DEPENDS_ON` can both stay |
| `05_extract_a_document.py` | The full pipeline | Names, links, a review count |
| `06_review_queue.py` | Holding uncertain items | Sentences, not raw dicts |
| `07_your_own_ontology.py` | A second ontology | People, companies, places |
| `08_compare_with_chat_model.py` | Decision vs chat JSON | Scores on the same note |
| `09_export_graph.py` | JSON, Cypher, HTML | A self-contained graph file |
