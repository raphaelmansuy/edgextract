#!/usr/bin/env python3
"""Article figures in the warm editorial style: cream paper, serif display, pastel rows.

    uv run python docs/article/svg/render_figures.py

Writes one SVG per figure next to this file. Render PNGs with rsvg-convert (see Makefile: figures).
Source file is ASCII only; non-ASCII glyphs are written as XML entities.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = json.loads((HERE.parent / "results.json").read_text(encoding="utf-8"))

W = 1100
PAGE = "#f7f3ec"
CARD = "#efe8da"
INK = "#1f1d1a"
MUTED = "#6b645a"
SOFT = "#9a9183"
SERIF = "Iowan Old Style, Georgia, Times New Roman, serif"
SANS = "Inter, Helvetica Neue, Helvetica, Arial, sans-serif"
MONO = "Menlo, SF Mono, Consolas, monospace"

# (fill, ink) pairs, pastel block plus its dark text tone.
SAGE = ("#cfe3c9", "#2f4d2a")
LAV = ("#d9d6f3", "#3d3a80")
PEACH = ("#f5d4c1", "#80401f")
ROSE = ("#f2d0d7", "#7f3446")
SAND = ("#f1e2b5", "#6f5210")
SKY = ("#cfe2ee", "#2b536f")


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def svg(height: int, aria: str, body: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" '
        f'viewBox="0 0 {W} {height}" role="img" aria-label="{esc(aria)}">\n'
        f'  <rect width="{W}" height="{height}" fill="{PAGE}"/>\n{body}\n</svg>\n'
    )


def text(x, y, s, *, size=15, fill=INK, family=SANS, weight=400, anchor="start", spacing=None):
    sp = f' letter-spacing="{spacing}"' if spacing else ""
    return (
        f'  <text x="{x}" y="{y}" fill="{fill}" font-family="{family}" font-size="{size}" '
        f'font-weight="{weight}" text-anchor="{anchor}"{sp}>{esc(s)}</text>'
    )


def rect(x, y, w, h, fill, *, rx=16, stroke=None, sw=1.2):
    st = f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ""
    return f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{st}/>'


def pill(x, y, s, *, fill="#e6dfd0", ink=INK, size=13, family=MONO, pad=10, h=24):
    w = int(len(s) * size * 0.6 + 2 * pad)
    return (
        rect(x, y, w, h, fill, rx=8)
        + "\n"
        + text(x + pad, y + h / 2 + size * 0.35, s, size=size, fill=ink, family=family)
    ), w


def row(y, h, colors, label, body_lines, *, label_w=262, strong=False, mono_last=False, tag=None):
    """The reference layout: pastel label block on the left, beige body on the right."""
    fill, ink = colors
    words = label.split(" ")
    if len(label) > 15 and len(words) > 1:
        cut = max(1, len(words) // 2) if len(words) > 2 else 1
        lines = [" ".join(words[:cut]), " ".join(words[cut:])]
    else:
        lines = [label]
    out = [
        rect(0, y, label_w, h, fill),
        rect(label_w + 10, y, W - label_w - 10, h, CARD),
    ]
    if strong:
        tag_s = "THE METHOD IN THIS ARTICLE"
        pw = int(len(tag_s) * 10.5 * 0.62 + 24)
        out.append(rect(W - 22 - pw, y + 14, pw, 24, ink, rx=12))
        out.append(text(W - 22 - pw / 2, y + 30, tag_s, size=10.5, fill="#ffffff", weight=700, anchor="middle", spacing=1.2))
    extra = 1 if tag else 0
    block = len(lines) + extra
    first = y + h / 2 - (block - 1) * 13 + 7
    for i, ln in enumerate(lines):
        out.append(text(24, first + i * 27, ln, size=22, fill=ink, family=SERIF, weight=600))
    if tag:
        out.append(text(24, first + len(lines) * 27 - 4, tag, size=12.5, fill=ink, family=MONO))
    n = len(body_lines)
    top = y + h / 2 - (n - 1) * 13 - 2
    for i, line in enumerate(body_lines):
        last = i == n - 1
        out.append(
            text(
                label_w + 32,
                top + i * 26 + 6,
                line,
                size=14 if (last and n > 1) else 16,
                fill=MUTED if (last and n > 1) else INK,
                family=MONO if (mono_last and last) else SANS,
                weight=400 if (last and n > 1) else 500,
            )
        )
    return "\n".join(out)


def node(cx, cy, label, colors, r=36, size=13):
    fill, ink = colors
    return (
        f'  <circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}"/>\n'
        + text(cx, cy + 5, label, size=size, fill=ink, weight=600, anchor="middle")
    )


def edge(x1, y1, x2, y2, label=None, *, dashed=False, lx=None, ly=None):
    d = ' stroke-dasharray="6 5"' if dashed else ""
    out = f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{SOFT}" stroke-width="1.6"{d}/>'
    if label:
        mx = lx if lx is not None else (x1 + x2) / 2
        my = ly if ly is not None else (y1 + y2) / 2
        w = int(len(label) * 6.8 + 16)
        out += (
            f'\n  <rect x="{mx - w / 2:.1f}" y="{my - 11:.1f}" width="{w}" height="22" rx="7" fill="{PAGE}"/>\n'
            + text(f"{mx:.1f}", f"{my + 4:.1f}", label, size=12, fill=MUTED, anchor="middle")
        )
    return out


def caption_mark(y=None):
    return ""


# ---------------------------------------------------------------------------


def problem() -> str:
    h = 300
    lw = 450
    rx0 = lw + 16
    rw = W - rx0
    body = [
        rect(0, 0, lw, h, CARD),
        text(28, 40, "THE NOTE", size=11, fill=SOFT, weight=700, spacing=2),
        text(28, 98, "Jane Doe joined Acme Inc in Berlin.", size=19, family=SERIF),
        text(28, 136, "Acme Inc uses EdgeQuake.", size=19, family=SERIF),
        text(28, 174, "EdgeQuake depends on PostgreSQL.", size=19, family=SERIF),
        rect(28, 214, lw - 56, 1.2, "#d9cfbb", rx=0),
        text(28, 252, "Readable by a person.", size=15, fill=MUTED),
        text(28, 276, "Not something you can query.", size=15, fill=MUTED),
        rect(rx0, 0, rw, h, CARD),
        text(rx0 + 28, 40, "THE SAME FACTS, AS A GRAPH", size=11, fill=SOFT, weight=700, spacing=2),
        edge(rx0 + 110, 112, rx0 + 330, 112, "works at"),
        edge(rx0 + 110, 112, rx0 + 110, 226, "in"),
        edge(rx0 + 330, 112, rx0 + 330, 226, "uses"),
        node(rx0 + 110, 112, "Jane Doe", LAV),
        node(rx0 + 330, 112, "Acme Inc", PEACH),
        node(rx0 + 110, 226, "Berlin", ROSE),
        node(rx0 + 330, 226, "EdgeQuake", SAGE, size=12),
        edge(rx0 + 366, 226, rx0 + 500, 226, "depends on"),
        node(rx0 + 530, 226, "PostgreSQL", SKY, r=40, size=11),
    ]
    return svg(h, "A note, and the same facts as a knowledge graph", "\n".join(body))


def landscape() -> str:
    rows = [
        (SAND, "Hand-written rules", ["Regex and word lists.", "Cheap and fast. Breaks on new names and new phrasing."]),
        (SKY, "Classic NLP taggers", ["Trained on news or biomedical text.", "Breaks when your list of kinds is different."]),
        (LAV, "Trained models", ["Best scores on the benchmark they trained on (SpERT-class).", "You must label data, then retrain for each domain."]),
        (ROSE, "Chat model, JSON", ["Fast to try, and works on anything.", "Gives no probability. Keeps every guess it writes."]),
        (PEACH, "This method", ["Code proposes. Your ontology limits. A decision model says yes or no.", "Your cutoff keeps, reviews, or drops each link."]),
    ]
    out, y = [], 0
    for i, (c, label, lines) in enumerate(rows):
        out.append(row(y, 80, c, label, lines, strong=(i == 4)))
        y += 80 + 12
    return svg(y - 12, "Five ways to extract names and links, this method highlighted", "\n".join(out))


def question() -> str:
    rows = [
        (SAGE, "Pick one", "Choice", ["Choose one label from a short list you wrote.", "returns: the winner, and how sure it is of every label"]),
        (LAV, "Yes or no", "Noul", ["Answer a yes-or-no question.", "Does EdgeQuake use PostgreSQL?  ->  0.99"]),
        (PEACH, "Give a level", "Score", ["Rate something on a short scale you wrote.", "returns: the expected level, and how sure it is of each"]),
    ]
    out, y = [], 0
    for c, label, tag, lines in rows:
        out.append(row(y, 100, c, label, lines, mono_last=True, tag="(called " + tag + ")"))
        y += 100 + 12
    return svg(y - 12, "Three kinds of closed question: pick one, yes or no, give a level", "\n".join(out))


def pipeline() -> str:
    # (number, name, what happens, worked example, who does it)
    steps = [
        ("1", "Split", "Cut the note into sentences.", "EdgeQuake depends on PostgreSQL.", "code"),
        ("2", "Spot names", "Find the names on your list, then clues in the markdown.", "EdgeQuake, PostgreSQL", "code"),
        ("3", "Name the kind", "Look up known names. Ask the model only about unknown ones.", "EdgeQuake = product,  PostgreSQL = technology", "model"),
        ("4", "Filter", "Your list says which links are legal between two kinds.", "product -> technology:  uses, depends on", "code"),
        ("5", "Check links", "One yes-or-no question for each legal link.", "uses 0.97     depends on 1.00", "model"),
        ("6", "Decide", "Your cutoffs turn each number into keep, review, or drop.", "0.97 and 1.00 are both above 0.80  ->  keep", "you"),
    ]
    actors = {
        "code": (SKY, "plain code"),
        "model": (LAV, "model answers"),
        "you": (PEACH, "your rule"),
    }
    h, gap, lw = 78, 18, 262
    out, y = [], 0
    for i, (n, name, what, ex, who) in enumerate(steps):
        (fill, ink), tag = actors[who]
        out.append(rect(0, y, lw, h, fill))
        out.append(rect(lw + 10, y, W - lw - 10, h, CARD))
        out.append(text(26, y + h / 2 + 12, n, size=38, fill=ink, family=SERIF, weight=600))
        out.append(text(66, y + h / 2 + 8, name, size=22, fill=ink, family=SERIF, weight=600))
        out.append(text(lw + 36, y + 35, what, size=16, fill=INK, weight=500))
        out.append(text(lw + 36, y + 61, ex, size=13.5, fill=MUTED, family=MONO))
        p, pw = pill(W - 22 - 150, y + 14, tag, fill=fill, ink=ink, size=12.5, pad=12, h=26)
        out.append(p)
        if i < len(steps) - 1:
            cx, cy = lw / 2, y + h + gap / 2
            out.append(f'  <path d="M{cx - 7} {cy - 4} L{cx} {cy + 4} L{cx + 7} {cy - 4}" fill="none" stroke="{SOFT}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>')
        y += h + gap
    out.append(text(0, y + 4, "Worked example: the sentence \"EdgeQuake depends on PostgreSQL.\" goes through all six steps.", size=14, fill=MUTED))
    return svg(y + 24, "Six steps: split, spot names, name the kind, filter, check links, decide", "\n".join(out))


def ontology() -> str:
    h = 380
    out = [rect(0, 0, W, h, CARD)]
    n = {
        "person": (170, 150, LAV),
        "org": (400, 100, PEACH),
        "product": (400, 270, SAGE),
        "tech": (640, 190, SKY),
        "place": (880, 100, ROSE),
        "event": (880, 270, SAND),
    }
    out.append(edge(206, 140, 364, 106, "works at"))
    out.append(edge(436, 270, 604, 204, "uses / depends on"))
    out.append(edge(436, 100, 844, 100, "located in"))
    out.append(edge(880, 136, 880, 234, "happened at"))
    out.append(edge(188, 184, 372, 250, "uses"))
    for label, (cx, cy, c) in n.items():
        out.append(node(cx, cy, label, c, r=42, size=14))
    out.append(text(28, 38, "THE LIST YOU WRITE: KINDS OF NAME, AND THE LINKS BETWEEN THEM", size=11, fill=SOFT, weight=700, spacing=2))
    out.append(text(28, 350, "A link outside this list is never asked, so it can never appear.", size=15, fill=MUTED))
    return svg(h, "An ontology: kinds of name and the legal links between them", "\n".join(out))


def gate() -> str:
    rows = [
        (SAGE, "Keep", ["The model is sure. The link goes into the graph.", "It carries its probability and the sentence it came from."]),
        (SAND, "Review", ["The model is unsure. The link waits for a person.", "It is written as a plain sentence, and drawn dashed on the graph."]),
        (ROSE, "Drop", ["The model says no, or your ontology forbids it.", "It never enters the graph."]),
    ]
    out, y = [], 0
    for c, label, lines in rows:
        out.append(row(y, 96, c, label, lines))
        y += 96 + 12
    out.append(text(0, y + 12, "Your code owns the two cutoffs. They start unfitted: fit them on your own labeled notes.", size=14, fill=MUTED))
    return svg(y + 28, "Keep, review, or drop", "\n".join(out))


def benchmark() -> str:
    d = RESULTS["conll04_test"]
    groups = [("SpERT, trained on CoNLL04", d["spert_trained"], True)]
    if d.get("tev1_final"):
        groups.append(("edgextract + tev1, final run", d["tev1_final"], False))
    groups.append(("edgextract + tev1, first run", d["tev1_first"], False))
    groups.append(("Mistral Small, JSON", d["mistral_small"], False))
    ox, oy, scale, ch = 70, 300, 240, 340
    out = [
        f'  <line x1="{ox}" y1="{oy}" x2="{W - 20}" y2="{oy}" stroke="#cfc4ad" stroke-width="1.4"/>',
    ]
    for v in (0.5, 1.0):
        yy = oy - v * scale
        out.append(f'  <line x1="{ox}" y1="{yy}" x2="{W - 20}" y2="{yy}" stroke="#e1d9c7" stroke-dasharray="3 6"/>')
        out.append(text(ox - 12, yy + 4, f"{v:.1f}", size=12, fill=SOFT, anchor="end"))
    out.append(text(ox - 12, oy + 4, "0", size=12, fill=SOFT, anchor="end"))
    gw = (W - ox - 20) // len(groups)
    for i, (label, vals, trained) in enumerate(groups):
        gx = ox + i * gw + gw / 2
        for j, (key, col) in enumerate((("names_f1", SAGE), ("links_f1", LAV))):
            v = vals[key]
            bx = gx - 62 + j * 66
            bh = v * scale
            out.append(rect(bx, oy - bh, 58, bh, col[0], rx=10, stroke=col[1] if trained else None, sw=1.6))
            out.append(text(bx + 29, oy - bh - 10, f"{v:.2f}", size=15, fill=col[1], weight=700, anchor="middle"))
        out.append(text(gx, oy + 28, label, size=13.5, fill=INK, weight=600, anchor="middle"))
        sub = "trained on the benchmark" if trained else "no training on the benchmark"
        out.append(text(gx, oy + 48, sub, size=12, fill=MUTED, anchor="middle"))
    lx = ox
    for lab, col in (("Names (F1)", SAGE), ("Links (F1)", LAV)):
        out.append(rect(lx, 14, 18, 18, col[0], rx=6))
        out.append(text(lx + 28, 28, lab, size=13.5, fill=MUTED))
        lx += 140
    return svg(ch, "CoNLL04 test F1 for names and links by method", "\n".join(out))


def speed() -> str:
    s = RESULTS["one_note_seconds"]
    items = [
        ("Mistral Small", "hosted API, chat JSON", s["mistral_small_hosted"], PEACH),
        ("tev1", "local, closed decisions", s["tev1"], SAGE),
        ("nimble", "local, closed decisions", s["nimble"], LAV),
        ("gemma4", "local, chat JSON", s["gemma4_local_chat"], ROSE),
    ]
    maxv = max(v for _, _, v, _ in items)
    bx, bw = 290, W - 290 - 110
    out, y = [], 6
    for name, sub, v, col in items:
        out.append(text(0, y + 22, name, size=19, family=SERIF, weight=600))
        out.append(text(0, y + 42, sub, size=12.5, fill=MUTED))
        out.append(rect(bx, y, max(8, bw * v / maxv), 40, col[0], rx=12))
        out.append(text(bx + max(8, bw * v / maxv) + 14, y + 27, f"{v:.1f} s", size=17, fill=col[1], weight=700))
        y += 62
    out.append(text(0, y + 18, "One seven-sentence software note, one machine. A hosted model is fast but sends your text out and bills by the token.", size=13.5, fill=MUTED))
    return svg(y + 34, "Seconds to extract one short note, by method", "\n".join(out))


def contract() -> str:
    h = 214
    cw = (W - 16) // 2
    out = [
        rect(0, 0, cw, h, SAGE[0]),
        text(28, 40, "A DECISION ENDPOINT", size=11, fill=SAGE[1], weight=700, spacing=2),
        text(28, 88, "POST /v1/systemone", size=26, family=MONO, weight=600, fill=SAGE[1]),
        text(28, 130, "You declare the answer type first.", size=16, fill=INK),
        text(28, 156, "You get a value inside it, with a probability.", size=16, fill=INK),
        text(28, 182, "Your code still decides what to keep.", size=16, fill=INK),
        rect(cw + 16, 0, cw, h, ROSE[0]),
        text(cw + 44, 40, "A JSON COAT ON A CHAT MODEL", size=11, fill=ROSE[1], weight=700, spacing=2),
        text(cw + 44, 88, "format / schema / grammar", size=26, family=MONO, weight=600, fill=ROSE[1]),
        text(cw + 44, 130, "It forces a legal string.", size=16, fill=INK),
        text(cw + 44, 156, "A legal string can still be the wrong branch.", size=16, fill=INK),
        text(cw + 44, 182, "The model is still writing the next token.", size=16, fill=INK),
    ]
    return svg(h, "A decision endpoint versus a JSON schema on a chat model", "\n".join(out))


def review() -> str:
    steps = [
        ("1", "Extract", "Code proposes. The model decides.", CARD),
        ("2", "Review list", "Unsure items wait as plain sentences.", SAND[0]),
        ("3", "Keep", "A person accepts. A solid line on the graph.", SAGE[0]),
        ("4", "Drop", "A person rejects. It never enters.", ROSE[0]),
    ]
    gap = 16
    cw = (W - 3 * gap) // 4
    out = []
    for i, (n, name, sub, fill) in enumerate(steps):
        x = i * (cw + gap)
        out.append(rect(x, 0, cw, 150, fill))
        out.append(text(x + 22, 38, n, size=12, fill=SOFT, weight=700, spacing=2))
        out.append(text(x + 22, 80, name, size=25, family=SERIF, weight=600))
        out.append(text(x + 22, 112, sub[:34], size=13, fill=MUTED))
        if len(sub) > 34:
            out.append(text(x + 22, 130, sub[34:].strip(), size=13, fill=MUTED))
    return svg(150, "Review workflow: extract, review, keep or drop", "\n".join(out))


def choose() -> str:
    rows = [
        (SAGE, "Use edgextract", ["You can write down your kinds and links, and you cannot label thousands of sentences.", "You want an unsure answer to wait for a person instead of entering the graph."]),
        (LAV, "Train a model", ["You have labeled sentences in your domain and you need the best score.", "On CoNLL04 a trained model scores 0.89 and 0.71. Nothing here does."]),
        (PEACH, "Ask a chat model", ["You are exploring, your list of kinds keeps changing, or a wrong link is cheap to delete.", "Expect extra links. Check them."]),
    ]
    out, y = [], 0
    for c, label, lines in rows:
        out.append(row(y, 96, c, label, lines))
        y += 96 + 12
    return svg(y - 12, "When to use edgextract, a trained model, or a chat model", "\n".join(out))


FIGURES = {
    "problem": problem,
    "landscape": landscape,
    "question": question,
    "pipeline": pipeline,
    "ontology": ontology,
    "gate": gate,
    "benchmark": benchmark,
    "speed": speed,
    "contract": contract,
    "review": review,
    "choose": choose,
}


def main() -> None:
    for name, fn in FIGURES.items():
        path = HERE / f"{name}.svg"
        path.write_text(fn(), encoding="utf-8")
        print("wrote", path.name)


if __name__ == "__main__":
    main()
