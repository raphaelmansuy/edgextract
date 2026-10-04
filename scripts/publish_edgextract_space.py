#!/usr/bin/env python3
"""Publish the static demo to a Hugging Face Space.

Default: raphaelmansuy/edgextract  (sdk: static, COOP/COEP headers)

Usage (from the repo root, after ``hf auth login`` with a *write* token):

    make demo-space-publish
    # or: python scripts/publish_edgextract_space.py --src web/dist

Static Spaces cannot run wasm-pack; upload the already-built ``web/dist``
(same lean tree GitHub Pages ships — no ONNX blobs).
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

DEFAULT_REPO = "raphaelmansuy/edgextract"
DEFAULT_SRC = Path("web/dist")
SPACE_CARD = Path("docs/hf-space-README.md")
WEIGHT_SUFFIXES = {".onnx", ".onnx_data", ".bin", ".safetensors"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--private", action="store_true")
    args = ap.parse_args()

    try:
        from huggingface_hub import HfApi, create_repo
    except ImportError:
        print("huggingface_hub is required: pip install huggingface_hub", file=sys.stderr)
        return 2

    src: Path = args.src
    if not (src / "index.html").is_file():
        print(f"missing {src / 'index.html'} — run: make demo-build", file=sys.stderr)
        return 1
    if not SPACE_CARD.is_file():
        print(f"missing {SPACE_CARD}", file=sys.stderr)
        return 1

    weights = [
        p
        for p in src.rglob("*")
        if p.is_file() and (p.suffix in WEIGHT_SUFFIXES or p.name.endswith(".onnx_data"))
    ]
    if weights:
        print("refusing to upload ONNX/weight blobs:", file=sys.stderr)
        for p in weights[:20]:
            print(f"  {p}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="edgextract-space-") as tmp:
        dest = Path(tmp)
        shutil.copytree(src, dest, dirs_exist_ok=True)
        shutil.copyfile(SPACE_CARD, dest / "README.md")
        print(f"creating/updating space {args.repo} (private={args.private})")
        try:
            create_repo(
                args.repo,
                repo_type="space",
                space_sdk="static",
                private=args.private,
                exist_ok=True,
            )
        except Exception as e:
            msg = str(e)
            if "403" in msg or "rights to create" in msg:
                print(
                    "Hugging Face token cannot create Spaces (need a write token).\n"
                    "  hf auth login\n"
                    "  # create a Write token at https://huggingface.co/settings/tokens\n"
                    "  make demo-space-publish\n"
                    "Or add GitHub Actions secret HF_TOKEN (write) so Pages workflow publishes the Space.",
                    file=sys.stderr,
                )
                return 3
            raise
        api = HfApi()
        api.upload_folder(
            folder_path=str(dest),
            repo_id=args.repo,
            repo_type="space",
            commit_message="Publish edgextract static WebGPU demo",
            ignore_patterns=[".DS_Store"],
        )
    print(f"done: https://huggingface.co/spaces/{args.repo}")
    print(f"app:  https://{args.repo.replace('/', '-')}.static.hf.space")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
