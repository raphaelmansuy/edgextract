# 09 — Lens: Front design

**WHY.** The report is the UI. It must print and stay readable.

Tokens: dark page `#0f1419`, card `#1a222c`, ink `#e8eef5`. Entity colors from the ontology YAML (PERSON `#7dd3fc`, ORGANIZATION `#c4b5fd`, PRODUCT `#86efac`, TECHNOLOGY `#fcd34d`, LOCATION `#fda4af`, EVENT `#fdba74`).

Bands: ACCEPT green, REVIEW amber, REJECT red. Contrast is high enough for a projector.

Type is ui-sans-serif; document body is mono so offsets match the source.

No framework. One HTML file. Title = markdown file name.

Tests: T-8 render_html contains legend and REVIEW.
