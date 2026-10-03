# 02 — System One contract (REQ-2)

**WHY.** Mixing a chat JSON schema with a decision endpoint is the bug this project exists to avoid. See WHY-1, FP-1.

Endpoint (Ollama 0.35.0+, checked 0.35.1): `POST http://localhost:11434/v1/systemone`.

Request: `model`, `state` (string or object), `questions` map, optional `images` (base64 PNG/JPEG/WebP, Clef family, 0.35.1).

Question types:

| type | criteria | result |
| choice | 2–26 named options | `choice`, `probabilities` (sum ~1), `confidence` |
| noul | optional false/true descriptions | `noul` = P(yes) in [0,1]. No confidence in the v0.35.1 notes sample or in our Nimble live sample |
| score | 2–26 ordered descriptions | expected level; see live body below |

Limits from Ollama Decision docs, not TypeSafe’s 255 options.

## Live recording (this repo, 2026-10-03, Ollama 0.35.1, model nimble)

Choice matched the v0.35.0 notes: winner `bug`, P≈0.978, confidence≈0.891, `output_tokens`: 1. Fixture: `tests/fixtures/nimble_choice.json`.

Noul+score, same host, **not invented**:

```json
"refund": { "type": "noul", "noul": 0.9987440469792703 }
"urgency": {
  "type": "score",
  "score": 0.7577822809389072,
  "legend": {
    "0": "Routine: no time pressure",
    "1": "Soon: a customer is inconvenienced",
    "2": "Immediate: a critical service is unavailable"
  },
  "probabilities": { "0": 0.247, "1": 0.748, "2": 0.005 },
  "confidence": 0.46482721502280133
}
```

`input_tokens` 471, `output_tokens` 3. Fixture: `tests/fixtures/nimble_noul_score.json`.

Score `legend` here is a **map of index to label**, not a list. Validator accepts a finite `score` and does not invent extra fields.

## Fail closed (EC-8, EC-9, EC-18)

Reject: missing `answers`, choice not in probability keys, probabilities far from sum 1, noul outside [0,1], HTTP 4xx/5xx, non-JSON. Tests: T-2.

Do not send decision models chat, tools, or thinking. Local requests need no API key.
