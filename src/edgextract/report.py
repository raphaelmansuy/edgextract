"""Self-contained HTML report: highlighted markdown, relations, review queue."""

from __future__ import annotations

import html
from pathlib import Path

from edgextract.ontology import Ontology
from edgextract.types import ExtractionResult, GateBand

CSS = """
:root { --bg:#0f1419; --card:#1a222c; --ink:#e8eef5; --muted:#9aa8b5; --line:#2a3542; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.5 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
main { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 1.8rem; margin: 0 0 8px; }
h2 { font-size: 1.15rem; margin: 28px 0 12px; letter-spacing: .02em; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin: 12px 0; }
.doc { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
mark { padding: 0 2px; border-radius: 3px; color: #0b1220; }
table { width:100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align:left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.badge { display:inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.ACCEPT { background:#bbf7d0; color:#14532d; }
.REVIEW { background:#fde68a; color:#78350f; }
.REJECT { background:#fecaca; color:#7f1d1d; }
.stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:10px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
.stat b { display:block; font-size:1.3rem; }
"""


def _highlight(text: str, result: ExtractionResult, ontology: Ontology) -> str:
    spans = []
    for tm in result.mentions:
        if tm.band is GateBand.REJECT:
            continue
        color = ontology.color_for(tm.entity_type) if tm.entity_type else "#94a3b8"
        spans.append((tm.mention.start, tm.mention.end, tm.entity_type, color, tm.mention.text))
    spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
    # drop overlaps
    kept = []
    last = -1
    for s in spans:
        if s[0] < last:
            continue
        kept.append(s)
        last = s[1]
    parts = []
    cursor = 0
    for start, end, typ, color, _txt in kept:
        parts.append(html.escape(text[cursor:start]))
        inner = html.escape(text[start:end])
        parts.append(
            f'<mark style="background:{html.escape(color)}" title="{html.escape(_pretty_type(typ))}">{inner}</mark>'
        )
        cursor = end
    parts.append(html.escape(text[cursor:]))
    return "".join(parts)


_VERBS = {
    "WORKS_AT": "works at",
    "WORKS_FOR": "works for",
    "USES": "uses",
    "PART_OF": "is part of",
    "LOCATED_IN": "is located in",
    "LIVES_IN": "lives in",
    "DEPENDS_ON": "depends on",
    "CREATED_BY": "was created by",
    "HAPPENED_AT": "happened at",
    "KILL": "killed",
    "ORG_BASED_IN": "is based in",
    "FOUNDED": "founded",
    "ACQUIRED": "acquired",
    "INVESTED_IN": "invested in",
    "HEADQUARTERED_IN": "is headquartered in",
}


def _pretty_name(name: str) -> str:
    text = str(name or "").strip()
    if not text:
        return "something unnamed"
    # Canonical graph ids are UPPER_SNAKE. Short all-caps words (RAG) stay as written.
    if "_" in text or (text.isupper() and len(text) > 4):
        return text.replace("_", " ").title()
    return text


def _pretty_type(type_id: str) -> str:
    text = str(type_id or "name").replace("_", " ").strip()
    return text.lower() or "name"


def _link_sentence(source: str, relation: str, target: str) -> str:
    code = str(relation or "").upper()
    if code in {"", "NONE", "NO_RELATION"}:
        return f"No listed link from {_pretty_name(source)} to {_pretty_name(target)}."
    verb = _VERBS.get(code, code.replace("_", " ").lower())
    return f"{_pretty_name(source)} {verb} {_pretty_name(target)}."


def _percent(value: object) -> str:
    if not isinstance(value, (int, float)):
        return ""
    return f" The model put this at {float(value):.0%}."


def _review_sentence(item: dict) -> str:
    kind = item.get("kind")
    if kind == "entity":
        mention = item.get("text") or "this mention"
        kind_name = _pretty_type(str(item.get("type") or "name"))
        article = "an" if kind_name[:1].lower() in "aeiou" else "a"
        return f"Check whether “{mention}” is {article} {kind_name}.{_percent(item.get('prob'))}"
    if kind == "relation":
        source = _pretty_name(str(item.get("source") or ""))
        target = _pretty_name(str(item.get("target") or ""))
        relation = str(item.get("type") or "").upper()
        if relation in {"", "NONE", "NO_RELATION"}:
            line = f"Check whether any real link holds from {source} to {target}."
        else:
            line = f"Check this possible link: {_link_sentence(source, relation, target)}"
        return f"{line}{_percent(item.get('prob'))}"
    return "A person should look at this item before it is written into the graph."


def _time_phrase(milliseconds: int) -> str:
    if milliseconds >= 1000:
        seconds = milliseconds / 1000
        unit = "second" if abs(seconds - 1.0) < 0.05 else "seconds"
        return f"{seconds:.1f} {unit}"
    unit = "millisecond" if milliseconds == 1 else "milliseconds"
    return f"{milliseconds} {unit}"


def render_html(
    text: str,
    result: ExtractionResult,
    ontology: Ontology,
    title: str,
    *,
    include_graph: bool = True,
) -> str:
    stats = result.metadata.get("stats") or {}
    highlighted = _highlight(text, result, ontology)
    names = {e.name: (e.display_name or _pretty_name(e.name)) for e in result.entities}
    rows_e = "\n".join(
        f"<tr><td>{html.escape(e.display_name or _pretty_name(e.name))}</td>"
        f"<td>{html.escape(_pretty_type(e.entity_type))}</td>"
        f"<td>{html.escape(e.description)}</td></tr>"
        for e in result.entities
    )
    rows_r = "\n".join(
        "<tr><td>{}</td><td>{}</td></tr>".format(
            html.escape(
                _link_sentence(
                    names.get(r.source, r.source),
                    r.relation_type,
                    names.get(r.target, r.target),
                )
            ),
            html.escape(r.description),
        )
        for r in result.relationships
    )
    review_rows = "\n".join(
        f"<tr><td><span class='badge REVIEW'>Review</span></td>"
        f"<td>{html.escape(_review_sentence(item))}</td></tr>"
        for item in result.review
    )
    legend = " ".join(
        f'<span class="badge" style="background:{html.escape(t.color)};color:#111">'
        f"{html.escape(_pretty_type(t.id))}</span> "
        f'<span class="muted">{html.escape(t.description)}</span>'
        for t in ontology.types
    )
    fitted = bool(result.metadata.get("gate_fitted"))
    cutoff = (
        "The accept and reject cutoffs were fitted on labeled examples."
        if fitted
        else "The accept and reject cutoffs are starting points. They have not been fitted on labeled examples."
    )
    model = str(result.metadata.get("model") or "the decision model")
    calls = int(stats.get("systemone_calls") or 0)
    graph = ""
    if include_graph:
        from edgextract.graph_html import CSS as GRAPH_CSS
        from edgextract.graph_html import graph_markup

        graph = graph_markup(result, ontology, title)
        extra_css = GRAPH_CSS
    else:
        extra_css = ""
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>{html.escape(title)}</title>
<style>{CSS}\n{extra_css}</style>
</head><body><main>
<h1>{html.escape(title)}</h1>
<p>This page is the full extraction report for one document. Highlighted words are names the extractor kept. The lists below say what kind of thing each name is, and which links between them were accepted. Anything uncertain is in the review list at the bottom, written as a sentence.</p>
<p class="muted">Decision model: {html.escape(model)}. Ontology: {html.escape(ontology.title or ontology.id)}.</p>
<div class="stats">
  <div class="stat"><span class="muted">Names kept</span><b>{len(result.entities)}</b></div>
  <div class="stat"><span class="muted">Links kept</span><b>{len(result.relationships)}</b></div>
  <div class="stat"><span class="muted">Needs a person</span><b>{len(result.review)}</b></div>
  <div class="stat"><span class="muted">Decision calls</span><b>{calls}</b></div>
  <div class="stat"><span class="muted">Time</span><b>{html.escape(_time_phrase(result.extraction_time_ms))}</b></div>
</div>
{graph}
<h2>What the colors mean</h2>
<p>{legend}</p>
<h2>Document</h2>
<div class="card doc">{highlighted}</div>
<h2>Names</h2>
<div class="card"><table><thead><tr><th>Name</th><th>Kind</th><th>Wording in the document</th></tr></thead>
<tbody>{rows_e or "<tr><td colspan=3 class=muted>No names were accepted.</td></tr>"}</tbody></table></div>
<h2>Links</h2>
<div class="card"><table><thead><tr><th>In plain words</th><th>Sentence it came from</th></tr></thead>
<tbody>{rows_r or "<tr><td colspan=2 class=muted>No links were accepted.</td></tr>"}</tbody></table></div>
<h2>Needs a person</h2>
<p class="muted">These items were not written into the graph. Read each line and decide.</p>
<div class="card"><table><thead><tr><th></th><th>What to check</th></tr></thead>
<tbody>{review_rows or "<tr><td colspan=2 class=muted>Nothing is waiting. Every item was either kept or dropped.</td></tr>"}</tbody></table></div>
<p class="muted">{html.escape(cutoff)}</p>
</main></body></html>
"""


def write_report(
    path: str | Path,
    text: str,
    result: ExtractionResult,
    ontology: Ontology,
    title: str,
    *,
    include_graph: bool = True,
) -> Path:
    out = Path(path)
    out.write_text(
        render_html(text, result, ontology, title, include_graph=include_graph),
        encoding="utf-8",
    )
    return out
