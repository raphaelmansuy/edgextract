#!/usr/bin/env python3
"""Build article.pdf with pandoc → HTML and weasyprint."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MD = HERE / "article.md"
CSS = HERE / "print.css"
COVER = HERE / "cover.html"
HTML = HERE / "_build" / "article.html"
PDF = HERE / "article.pdf"


def main() -> int:
    pandoc = shutil.which("pandoc")
    weasy = shutil.which("weasyprint")
    if not pandoc:
        print("pandoc is required", file=sys.stderr)
        return 1
    if not weasy:
        print("weasyprint is required", file=sys.stderr)
        return 1
    HTML.parent.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(
        [
            pandoc,
            str(MD),
            "-s",
            "--from=markdown",
            "--to=html5",
            "--embed-resources",
            "--toc",
            f"--include-before-body={COVER}",
            "--syntax-highlighting=none",
            "--metadata=pagetitle:Extract a knowledge graph with a Jev-style decision model on Ollama",
            "--metadata=author-meta:Raphael MANSUY",
            "--toc-depth=1",
            "--metadata=lang:en",
            f"--css={CSS}",
            f"--resource-path={HERE}",
            "-o",
            str(HTML),
        ]
    )
    subprocess.check_call([weasy, str(HTML), str(PDF)])
    print(f"wrote {PDF} ({PDF.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
