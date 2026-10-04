#!/usr/bin/env python3
"""Publish the local WebGPU ONNX slice to Hugging Face.

Default target: raphaelmansuy/tev1-0.8b-onnx-webgpu

Usage (from the repo root, after ``hf auth login``):

    python scripts/publish_tev1_webgpu_model.py
    # or: make demo-webgpu-publish

Requires a filled ``web/public/models/tev1-0.8b-onnx`` (see
``scripts/fetch_tev1_webgpu_model.py``).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_REPO = "raphaelmansuy/tev1-0.8b-onnx-webgpu"
DEFAULT_SRC = Path("web/public/models/tev1-0.8b-onnx")

# Same q4f16 slice the demo loads (+ model card).
ALLOW = {
    "README.md",
    "ATTRIBUTION.md",
    "LICENSE-THIRD-PARTY.txt",
    "QUANTIZE.md",
    "edgextract-tev1.json",
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "preprocessor_config.json",
    "processor_config.json",
    "chat_template.jinja",
    "onnx/decoder_model_merged_q4f16.onnx",
    "onnx/decoder_model_merged_q4f16.onnx_data",
    "onnx/embed_tokens_q4f16.onnx",
    "onnx/embed_tokens_q4f16.onnx_data",
    "onnx/vision_encoder_q4f16.onnx",
    "onnx/vision_encoder_q4f16.onnx_data",
    "onnx/decoder_model_merged_fp16.onnx",
    "onnx/decoder_model_merged_fp16.onnx_data",
    "onnx/embed_tokens_fp16.onnx",
    "onnx/embed_tokens_fp16.onnx_data",
    "onnx/vision_encoder_fp16.onnx",
    "onnx/vision_encoder_fp16.onnx_data",
}


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
    if not (src / "config.json").is_file():
        print(
            f"missing {src / 'config.json'} — run: python scripts/fetch_tev1_webgpu_model.py",
            file=sys.stderr,
        )
        return 1

    files = [p for p in src.rglob("*") if p.is_file() and p.relative_to(src).as_posix() in ALLOW]
    if not any(p.name == "config.json" for p in files):
        print("config.json not in upload set", file=sys.stderr)
        return 1

    print(f"creating/updating {args.repo} (private={args.private})")
    create_repo(args.repo, repo_type="model", private=args.private, exist_ok=True)
    api = HfApi()
    for path in sorted(files, key=lambda p: p.as_posix()):
        rel = path.relative_to(src).as_posix()
        print(f"  upload {rel}  ({path.stat().st_size / 1e6:.1f} MB)")
        api.upload_file(
            path_or_fileobj=str(path),
            path_in_repo=rel,
            repo_id=args.repo,
            repo_type="model",
        )
    print(f"done: https://huggingface.co/{args.repo}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
