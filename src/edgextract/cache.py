"""SQLite decision cache and run ledger. Same (model, state, questions) never hits the host twice."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS decisions (
  cache_key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  document_id TEXT,
  model TEXT,
  ontology_id TEXT,
  started_at REAL,
  finished_at REAL,
  stats_json TEXT,
  result_json TEXT
);
"""


def request_key(model: str, state: Any, questions: dict[str, Any], images: list[str] | None) -> str:
    payload = {"model": model, "state": state, "questions": questions, "images": images or []}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class DecisionCache:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def get(self, key: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT response_json FROM decisions WHERE cache_key = ?", (key,)
        ).fetchone()
        if not row:
            return None
        return json.loads(row[0])

    def put(self, key: str, model: str, response: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO decisions(cache_key, model, body_hash, response_json, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (key, model, key, json.dumps(response, ensure_ascii=False), time.time()),
        )
        self._conn.commit()

    def record_run(
        self,
        run_id: str,
        document_id: str,
        model: str,
        ontology_id: str,
        stats: dict[str, Any],
        result: dict[str, Any],
        started_at: float,
        finished_at: float,
    ) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO runs(run_id, document_id, model, ontology_id, started_at, "
            "finished_at, stats_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                document_id,
                model,
                ontology_id,
                started_at,
                finished_at,
                json.dumps(stats),
                json.dumps(result),
            ),
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()
