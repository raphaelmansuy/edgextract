import "./style.css";
import wasmUrl from "./wasm/edgextract_bg.wasm?url";
import { EngineClient, EngineError } from "./engine";
import { GraphView, type GEdge, type GNode } from "./graph";
import { addToGazetteer, suggestNames } from "./names";
import { DEMO_ONTOLOGIES, ONTOLOGY_BLURBS } from "./ontologies";
import { SAMPLES } from "./samples";
import type {
  Flagged,
  Plan,
  Progress,
  OntologyFile,
  OntologyInfo,
  RunOutput,
  RunRequest,
} from "./types";

// ---------------------------------------------------------------- helpers

function $<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const human = (rel: string): string => rel.toLowerCase().replace(/_/g, " ");
const p2 = (v: number): string => v.toFixed(2);

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Rust reports UTF-8 byte offsets; JavaScript strings are indexed in UTF-16 units. */
function byteToIndex(text: string): (byte: number) => number {
  const map = new Map<number, number>();
  let bytes = 0;
  let idx = 0;
  for (const ch of text) {
    map.set(bytes, idx);
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    idx += ch.length;
  }
  map.set(bytes, idx);
  return (b) => map.get(b) ?? idx;
}

// ---------------------------------------------------------------- state

type Tab = "document" | "links" | "review" | "json";

const state = {
  ontologies: [] as OntologyFile[],
  starter: "",
  info: null as OntologyInfo | null,
  yamlValid: true,
  sample: SAMPLES[0].id,
  tab: "document" as Tab,
  last: null as RunOutput | null,
  completed: 0,
};

const engine = new EngineClient();
const graph = new GraphView($("graph") as unknown as SVGSVGElement, {
  onHover: (e) => showEvidence(e),
  onSelect: (e) => {
    pinned = e;
    showEvidence(e);
  },
});
let pinned: GEdge | null = null;

// ---------------------------------------------------------------- inputs

const textEl = $<HTMLTextAreaElement>("text");
const yamlEl = $<HTMLTextAreaElement>("yaml");
const ontologyEl = $<HTMLSelectElement>("ontology");
const keepEl = $<HTMLInputElement>("keep");
const dropEl = $<HTMLInputElement>("drop");

function cutoffs(): { keep: number; drop: number } {
  return { keep: Number(keepEl.value), drop: Number(dropEl.value) };
}

function paintBands(): void {
  const { keep, drop } = cutoffs();
  $("keep-out").textContent = p2(keep);
  $("drop-out").textContent = p2(drop);
  const bands = $("bands");
  bands.style.setProperty("--drop", `${drop * 100}%`);
  bands.style.setProperty("--keep", `${keep * 100}%`);
}

// ---------------------------------------------------------------- run
//
// Reading a long document is a long wait on a slow, costly model, so it is a visible,
// stoppable process: a plan before it starts, a progress card while it runs, the graph
// growing section by section, and a clear way to continue or keep what was read.

type Phase = "idle" | "preparing" | "planned" | "running" | "stopping" | "paused" | "done" | "error";
let phase: Phase = "idle";

function setPhase(next: Phase): void {
  phase = next;
  document.body.dataset.phase = next;
  $("run").setAttribute("aria-busy", String(next === "preparing" || next === "running" || next === "stopping"));
}

/** Above this many forecast model calls the page asks before reading. */
const AUTO_CALLS = 40;
/** What one model call costs, until this session has seen real answers. */
const GUESS_CALL_MS = 3000;

const read = {
  /** Average milliseconds per model call seen in this session. */
  msPerCall: GUESS_CALL_MS,
  learned: false,
  /** The prepared document in the worker can be carried on from where it stopped. */
  resumable: false,
  /** Sections of the whole document, and how many the shown graph covers. */
  total: 0,
  covered: 0,
  startedAt: 0,
  startSection: 0,
  waitingSince: 0,
  /** Model calls answered since the last section finished (the section's own count lags). */
  live: 0,
  progress: null as Progress | null,
  /** A newer request arrived while one was running: do it next, once. */
  again: null as RunOpts | null,
};

interface RunOpts {
  /** Re-read cached answers after a cutoff moved; asks the model nothing new. */
  regate?: boolean;
  /** The reader already agreed to the forecast. */
  consent?: boolean;
}

const host = (): { baseUrl: string } => ({ baseUrl: $<HTMLInputElement>("host-url").value.trim() });
const busy = (): boolean => phase === "preparing" || phase === "running" || phase === "stopping";

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const clock = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function showError(message: string | null, retry = false): void {
  const box = $("error");
  box.hidden = message == null;
  $("error-text").textContent = message ?? "";
  $("retry").hidden = !retry;
}

function showNotice(text: string | null, action = "Continue reading"): void {
  $("notice").hidden = text == null;
  $("notice-text").textContent = text ?? "";
  $("continue").textContent = action;
}

function hidePlan(): void {
  $("plan").hidden = true;
}

// ---- progress card

function showProgress(on: boolean): void {
  $("progress").hidden = !on;
  if (!on) $("stop").removeAttribute("disabled");
}

function paintProgress(): void {
  const p = read.progress;
  const elapsed = performance.now() - read.startedAt;
  const multi = !!p && p.sections > 1;
  const stopping = phase === "stopping";
  $("progress-title").textContent = stopping
    ? "Stopping after this section…"
    : phase === "preparing"
      ? "Preparing the document…"
      : multi
        ? `Reading section ${Math.min(p.section + 1, p.sections)} of ${p.sections}`
        : "Asking the model…";
  const bar = $("bar");
  bar.classList.toggle("indeterminate", !multi);
  if (multi) {
    const pct = Math.round((p.section / p.sections) * 100);
    $("bar-fill").style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
  } else {
    $("bar-fill").style.width = "";
    bar.removeAttribute("aria-valuenow");
  }
  const parts: string[] = [];
  if (p) {
    const calls = p.calls + read.live;
    parts.push(`${calls} model call${calls === 1 ? "" : "s"}`);
  }
  if (phase !== "preparing") parts.push(`${clock(elapsed)} elapsed`);
  if (multi && p.section - read.startSection >= 2 && elapsed > 3000) {
    const perSection = elapsed / (p.section - read.startSection);
    parts.push(`about ${fmtDuration(perSection * (p.sections - p.section))} left`);
  }
  $("progress-detail").textContent = parts.join(" · ");
  $("progress-wait").textContent = read.waitingSince
    ? `waiting for the model… ${Math.round((performance.now() - read.waitingSince) / 1000)} s`
    : "";
}

setInterval(() => {
  if (!$("progress").hidden) paintProgress();
}, 250);

engine.onCall = (e) => {
  if (e.state === "start") {
    read.waitingSince = performance.now();
  } else {
    read.waitingSince = 0;
    read.live++;
    if (e.ms != null) {
      // A running average, so the forecast learns this host's real speed.
      read.msPerCall = read.learned ? read.msPerCall * 0.7 + e.ms * 0.3 : e.ms;
      read.learned = true;
    }
  }
};

// ---- the plan: shown instead of reading when a document is big

function offerPlan(plan: Plan): void {
  const words = (textEl.value.match(/\S+/g) ?? []).length;
  const f = plan.forecast;
  const est = Math.max(f.estimated_calls, 1);
  const preview = Math.max(1, Math.min(plan.sections, Math.floor((plan.sections * AUTO_CALLS) / est)));
  const previewCalls = Math.max(1, Math.round((est * preview) / plan.sections));
  const perCall = `${(read.msPerCall / 1000).toFixed(1)} s per call${read.learned ? "" : ", a guess until the first answers"}`;
  $("plan-title").textContent = "This is a long document";
  $("plan-body").innerHTML =
    `<b>${words.toLocaleString()}</b> words in <b>${plan.sentences.toLocaleString()}</b> sentences, read in <b>${plan.sections}</b> sections. ` +
    `The model will be asked about <b>${f.unknown_names.toLocaleString()}</b> names, so expect about <b>${est.toLocaleString()}</b> model calls, ` +
    `roughly <b>${fmtDuration(est * read.msPerCall)}</b> (${perCall}). ` +
    `You can stop at any time and keep what was read.`;
  $("plan-preview").textContent = `Read the first ${preview} section${preview === 1 ? "" : "s"} · about ${fmtDuration(previewCalls * read.msPerCall)}`;
  $("plan-all").textContent = `Read everything · about ${fmtDuration(est * read.msPerCall)}`;
  ($("plan-preview") as HTMLElement).dataset.limit = String(preview);
  $("plan").hidden = false;
  paintEmpty();
  $("empty").hidden = true;
}

// ---- running

function request(): RunRequest {
  const { keep, drop } = cutoffs();
  return {
    text: textEl.value,
    ontology_yaml: yamlEl.value,
    document_id: SAMPLES.find((s) => s.id === state.sample)?.id ?? "note",
    model: $<HTMLInputElement>("host-model").value.trim() || "tev1",
    // A document's names are rarely all on a list: let the model judge every capitalized run.
    discover_names: true,
    // The same two numbers gate yes/no links and name checks.
    gate: { noul_yes: keep, noul_no: drop },
  };
}

/** On a small screen the graph is a separate view: take the reader to it when reading starts. */
function showGraphOnSmallScreens(): void {
  if (compact.matches) showView("graph");
}

async function run(opts: RunOpts = {}): Promise<void> {
  if (!state.yamlValid) return;
  if (busy()) {
    // One reading at a time. Remember the newest wish and stop what is running.
    read.again = opts;
    if (phase === "running") stopReading();
    return;
  }
  showError(null);
  showNotice(null);
  hidePlan();
  $("run-note").textContent = "";
  read.resumable = false;
  read.progress = null;
  read.startedAt = performance.now();
  read.waitingSince = 0;
  showGraphOnSmallScreens();
  setPhase("preparing");
  showProgress(true);
  paintProgress();
  try {
    const req = request();
    // After a partial read, moving a cutoff re-reads only what was read, from the cache.
    if (opts.regate && read.covered > 0 && read.covered < read.total) req.max_sections = read.covered;
    const plan = await engine.prepare(req, host());
    read.total = plan.total_sections;
    read.progress = plan.progress;
    read.live = 0;
    if (read.again) return;
    if (!opts.consent && !opts.regate && plan.forecast.estimated_calls > AUTO_CALLS) {
      setPhase("planned");
      offerPlan(plan);
      return;
    }
    await readDocument();
  } catch (e) {
    fail(e);
  } finally {
    rest();
  }
}

/** The reader chose from the plan: read the document that is already prepared. */
async function startReading(limit?: number): Promise<void> {
  showError(null);
  showNotice(null);
  showGraphOnSmallScreens();
  try {
    await readDocument(limit);
  } catch (e) {
    fail(e);
  } finally {
    rest();
  }
}

/** Read the prepared document from where it is, to the end or until stopped. */
async function readDocument(limit?: number): Promise<void> {
  setPhase("running");
  read.startedAt = performance.now();
  read.startSection = read.progress?.section ?? 0;
  $("stop").removeAttribute("disabled");
  showProgress(true);
  const { output, stopped } = await engine.run(
    {
      onProgress: (p, out) => {
        read.progress = p;
        read.live = 0;
        paintProgress();
        if (out) show(out);
      },
    },
    limit,
  );
  show(output);
  read.covered = output.progress.section;
  read.resumable = stopped;
  if (read.again) return;
  const s = output.result.metadata.stats;
  if (s.systemone_calls > 0 && s.decision_wall_ms > 0) {
    read.msPerCall = s.decision_wall_ms / s.systemone_calls;
    read.learned = true;
  }
  if (read.covered < read.total) {
    setPhase("paused");
    showNotice(
      stopped
        ? `Stopped after section ${read.covered} of ${read.total}. This is what was read so far.`
        : `Showing the first ${read.covered} of ${read.total} sections.`,
      stopped ? "Continue reading" : "Read the rest",
    );
  } else {
    setPhase("done");
  }
}

function stopReading(): void {
  if (phase !== "running") return;
  setPhase("stopping");
  $("stop").setAttribute("disabled", "");
  paintProgress();
  engine.stop();
}

function fail(e: unknown): void {
  const err = e as EngineError;
  const partial = err.partial;
  setPhase("error");
  if (partial && partial.progress.section > 0) {
    // Keep what was read: a failure at section 40 must not erase sections 1 to 39.
    show(partial);
    read.covered = partial.progress.section;
    read.resumable = true;
    showError(
      `${err.message}\n\nStopped at section ${partial.progress.section + 1} of ${read.total}. What was read before is shown; nothing was invented.`,
      true,
    );
  } else {
    read.resumable = false;
    state.last = null;
    paintEmpty();
    showError(`${err.message}\n\nNothing was invented: with no answer from the model, the graph stays empty.`, true);
  }
}

/** A reading has come to rest (finished, stopped, planned, or failed). */
function rest(): void {
  showProgress(false);
  read.waitingSince = 0;
  // Tests and scripts wait on this counter instead of sleeping.
  document.body.dataset.runs = String(++state.completed);
  if (read.again) {
    const next = read.again;
    read.again = null;
    void run(next);
  }
}

/** "Continue" after a stop or a failure: carry on in the worker if it still holds the document. */
async function resume(): Promise<void> {
  if (busy()) return;
  if (!read.resumable) {
    void run({ consent: true });
    return;
  }
  showError(null);
  showNotice(null);
  try {
    await readDocument();
  } catch (e) {
    fail(e);
  } finally {
    rest();
  }
}

const runSoon = debounce(() => void run(), 300);
const regateSoon = debounce(() => void run({ regate: true }), 300);

// ---------------------------------------------------------------- painting

function colorOf(info: OntologyInfo, type: string): string {
  return info.types.find((t) => t.id === type)?.color ?? "#94a3b8";
}

function paintKinds(info: OntologyInfo): void {
  $("kinds").innerHTML = info.types
    .map(
      (t) =>
        `<span class="kind" title="${esc(t.description)}" style="--c:${t.color}">${esc(human(t.id))}</span>`,
    )
    .join("");
  $("legend").innerHTML = info.types
    .map((t) => `<span class="lg" style="--c:${t.color}"><i></i>${esc(human(t.id))}</span>`)
    .join("") +
    `<span class="lg ghost"><i></i>waiting for a person</span>`;
}

function stat(id: string, label: string, value: string | number, tone = ""): string {
  return `<div class="stat ${tone}" data-testid="stat-${id}"><b>${value}</b><span>${label}</span></div>`;
}

function paintStats(out: RunOutput | null): void {
  if (!out) {
    $("stats").innerHTML = "";
    return;
  }
  const s = out.result.metadata.stats;
  const droppedLinks = out.result.rejected.filter((r) => r.kind === "relation").length;
  const dropped = out.result.rejected.length;
  $("stats").innerHTML =
    stat("names", "names kept", out.result.entities.length) +
    stat("links", "links kept", out.result.relationships.length, "good") +
    stat("review", "for a person", out.result.review.length, "warn") +
    stat("dropped", "dropped", dropped, "mute") +
    `<div class="sep"></div>` +
    (out.progress.sections > 1
      ? stat("read", "sentences read", `${out.progress.sentences_done.toLocaleString()}/${out.progress.sentences.toLocaleString()}`)
      : "") +
    stat("calls", "model calls", s.systemone_calls) +
    stat("cached", "answers from cache", s.questions_from_cache) +
    stat("ms", "ms in wasm", s.elapsed_ms) +
    `<span class="hidden" data-testid="stat-dropped-links">${droppedLinks}</span>`;
}

const sentenceIndex = new WeakMap<RunOutput, Map<string, string>>();

function sentenceText(out: RunOutput, id: string): string {
  let index = sentenceIndex.get(out);
  if (!index) {
    index = new Map(out.sentences.map((s) => [s.id, s.text]));
    sentenceIndex.set(out, index);
  }
  return index.get(id) ?? "";
}

/** A graph of hundreds of names is unreadable. Draw the best connected; the rest stay in the lists. */
const MAX_GRAPH_NODES = 80;
/** Long lists are cut so the page stays quick; the JSON tab always has everything. */
const MAX_ROWS = 200;

function buildGraph(out: RunOutput): { nodes: GNode[]; edges: GEdge[]; total: number } {
  const info = out.ontology;
  const display = new Map<string, string>();
  const nodes = new Map<string, GNode>();
  for (const e of out.result.entities) {
    const label = e.display_name ?? e.name;
    display.set(label.toLowerCase(), e.name);
    nodes.set(e.name, {
      id: e.name,
      label,
      type: e.entity_type,
      color: colorOf(info, e.entity_type),
      pending: false,
    });
  }
  const edges: GEdge[] = out.result.relationships.map((r, i) => ({
    id: `k${i}`,
    source: r.source,
    target: r.target,
    relation: r.relation_type,
    weight: r.weight,
    evidence: r.description,
    pending: false,
  }));
  // Ghost edges: links the model was unsure about, drawn only between kept names.
  out.result.review
    .filter((r) => r.kind === "relation" && r.asked && r.source && r.target)
    .forEach((r, i) => {
      const s = display.get((r.source ?? "").toLowerCase());
      const t = display.get((r.target ?? "").toLowerCase());
      if (!s || !t) return;
      edges.push({
        id: `p${i}`,
        source: s,
        target: t,
        relation: r.asked ?? "",
        weight: r.prob,
        evidence: sentenceText(out, r.sentence_id),
        pending: true,
      });
    });
  // Names the model was unsure about appear as dashed nodes.
  for (const r of out.result.review.filter((x) => x.kind === "entity" && x.text)) {
    const id = (r.text ?? "").toUpperCase().replace(/\s+/g, "_");
    if (nodes.has(id)) continue;
    nodes.set(id, {
      id,
      label: r.text ?? id,
      type: r.type && r.type !== "NOT_ENTITY" ? r.type : "unsure",
      color: "#fbbf24",
      pending: true,
    });
  }
  return capGraph([...nodes.values()], edges);
}

function capGraph(nodes: GNode[], edges: GEdge[]): { nodes: GNode[]; edges: GEdge[]; total: number } {
  const total = nodes.length;
  if (total <= MAX_GRAPH_NODES) return { nodes, edges, total };
  const degree = new Map<string, number>();
  for (const e of edges) {
    const w = e.pending ? 0.4 : 1;
    degree.set(e.source, (degree.get(e.source) ?? 0) + w);
    degree.set(e.target, (degree.get(e.target) ?? 0) + w);
  }
  const rank = (n: GNode) => (degree.get(n.id) ?? 0) - (n.pending ? 0.5 : 0);
  const keep = new Set(
    [...nodes]
      .sort((a, b) => rank(b) - rank(a) || a.label.localeCompare(b.label))
      .slice(0, MAX_GRAPH_NODES)
      .map((n) => n.id),
  );
  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    total,
  };
}

function paintGraph(out: RunOutput): void {
  const { nodes, edges, total } = buildGraph(out);
  const note = $("graph-note");
  note.hidden = total <= nodes.length;
  note.textContent = `Showing the ${nodes.length} best-connected of ${total.toLocaleString()} names. All of them are in Links and JSON.`;
  const empty = $("empty");
  if (!nodes.length) {
    empty.hidden = false;
    empty.classList.remove("low");
    const asked = out.result.metadata.stats.mentions_proposed;
    const hint = !asked
      ? `No capitalized names were found in this text, so there was nothing to ask the model.`
      : out.result.review.length
        ? `The model was asked about ${asked} candidate${asked === 1 ? "" : "s"}; ${out.result.review.length} wait in the Review tab, and none passed the keep cutoff. Lower it, or check that the kinds in step 2 fit this text.`
        : `The model was asked about ${asked} candidate${asked === 1 ? "" : "s"} and none was a name this ontology can hold. Check that the kinds in step 2 fit this text.`;
    empty.innerHTML = `<b>No names kept.</b><span>${hint}</span>`;
  } else if (!out.result.relationships.length) {
    empty.hidden = false;
    empty.innerHTML = `<b>Names found, but no link passed the cutoff.</b><span>Check the Review tab, or lower the keep cutoff.</span>`;
    empty.classList.add("low");
  } else {
    empty.hidden = true;
    empty.classList.remove("low");
  }
  // Size the drawing after the caption takes its row, so names are not fitted under it.
  graph.update(nodes, edges);
}

function showEvidence(e: GEdge | null): void {
  const box = $("evidence");
  const shown = e ?? pinned;
  if (!shown) {
    box.innerHTML = `<span class="hint">Hover a link to see the sentence behind it. Drag a name to move it.</span>`;
    box.classList.remove("on");
    return;
  }
  box.classList.add("on");
  const tag = shown.pending ? `<em class="tag warn">waiting for a person</em>` : `<em class="tag good">kept</em>`;
  box.innerHTML =
    `<q data-testid="evidence-text">${esc(shown.evidence)}</q>` +
    `<span class="meta">${esc(human(shown.relation))} · the model said ${p2(shown.weight)} ${tag}</span>`;
}

// ---- document tab

function paintDocument(out: RunOutput): void {
  const text = textEl.value;
  const toIdx = byteToIndex(text);
  const info = out.ontology;
  const marks = out.result.mentions
    .map((m) => ({ ...m, a: toIdx(m.mention.start), b: toIdx(m.mention.end) }))
    .filter((m) => m.b > m.a)
    .sort((x, y) => x.a - y.a);
  let html = "";
  let cursor = 0;
  for (const m of marks) {
    if (m.a < cursor) continue;
    html += esc(text.slice(cursor, m.a));
    const surface = esc(text.slice(m.a, m.b));
    const notName = m.entity_type === "NOT_ENTITY";
    const cls = m.band === "ACCEPT" && !notName ? "accept" : notName && m.band === "REJECT" ? "reject" : "review";
    const label = notName ? "not a name?" : human(m.entity_type);
    const color = notName ? "#94a3b8" : colorOf(info, m.entity_type);
    html +=
      `<mark class="m ${cls}" data-testid="mention" data-band="${m.band}" data-type="${esc(m.entity_type)}" ` +
      `style="--c:${color}" title="${esc(label)} · ${p2(m.winner_prob)} · decided by ${esc(m.decided_by)}">` +
      `${surface}<sup>${esc(label)}${cls === "review" && !notName ? " ?" : ""}</sup></mark>`;
    cursor = m.b;
  }
  html += esc(text.slice(cursor));
  $("pane-document").innerHTML =
    `<div class="doc" data-testid="doc">${html}</div>` +
    `<p class="doc-note">Solid colour: a kept name. Dashed: the model was unsure. ` +
    `Pronouns and code fences are never turned into names.</p>`;
}

// ---- links tab

function paintLinks(out: RunOutput): void {
  const info = out.ontology;
  const byName = new Map(out.result.entities.map((e) => [e.name, e]));
  const chip = (name: string) => {
    const e = byName.get(name);
    return `<span class="ent" style="--c:${colorOf(info, e?.entity_type ?? "")}">${esc(e?.display_name ?? name)}</span>`;
  };
  const rows = out.result.relationships
    .slice(0, MAX_ROWS)
    .map(
      (r) =>
        `<li class="card" data-testid="link-row" data-relation="${esc(r.relation_type)}">` +
        `<div class="triple">${chip(r.source)}<span class="rel">${esc(human(r.relation_type))}</span>${chip(r.target)}` +
        `<span class="w" title="the model's probability">${p2(r.weight)}</span></div>` +
        `<q>${esc(r.description)}</q></li>`,
    )
    .join("");
  const more = out.result.relationships.length - MAX_ROWS;
  $("pane-links").innerHTML = rows
    ? `<ul class="cards">${rows}</ul>` +
      (more > 0 ? `<p class="blank">${more.toLocaleString()} more links are in the JSON tab.</p>` : "")
    : `<p class="blank">No link passed your cutoff.</p>`;
}

// ---- review tab

function reviewCard(out: RunOutput, r: Flagged, cut: { keep: number; drop: number }): string {
  const between = `That sits between your drop cutoff (${p2(cut.drop)}) and keep cutoff (${p2(cut.keep)}), so a person should decide.`;
  const q = sentenceText(out, r.sentence_id);
  if (r.kind === "relation") {
    const why =
      r.reason === "endpoint_not_accepted"
        ? "One end of this link is not a kept name yet."
        : between;
    return (
      `<li class="card warn" data-testid="review-row" data-kind="relation">` +
      `<div class="ask">Does <b>${esc(human(r.asked ?? "link"))}</b> hold from <b>${esc(r.source ?? "")}</b> to <b>${esc(r.target ?? "")}</b>?` +
      `<span class="w">${p2(r.prob)}</span></div>` +
      `<p class="why">The model said ${p2(r.prob)}. ${why}</p><q>${esc(q)}</q></li>`
    );
  }
  const typed = r.type && r.type !== "NOT_ENTITY";
  const ask = typed
    ? `Which kind is <b>${esc(r.text ?? "")}</b>? Best guess: <b>${esc(human(r.type ?? ""))}</b>`
    : `Is <b>${esc(r.text ?? "")}</b> a name this ontology can hold?`;
  return (
    `<li class="card warn" data-testid="review-row" data-kind="entity">` +
    `<div class="ask">${ask}<span class="w">${p2(r.prob)}</span></div>` +
    `<p class="why">${typed ? `The model's best kind scored only ${p2(r.prob)}.` : `The model said ${p2(r.prob)}.`} ${between}</p>` +
    `<q>${esc(q)}</q></li>`
  );
}

function paintReview(out: RunOutput): void {
  const cut = cutoffs();
  const review = out.result.review;
  const dropped = out.result.rejected;
  const droppedRows = dropped
    .slice(0, MAX_ROWS)
    .map((r) =>
      r.kind === "relation"
        ? `<li data-testid="dropped-row"><span>${esc(human(r.asked ?? "link"))}</span> ${esc(r.source ?? "")} → ${esc(r.target ?? "")}<b>${p2(r.prob)}</b></li>`
        : `<li data-testid="dropped-row"><span>name</span> ${esc(r.text ?? "")}<b>${p2(r.prob)}</b></li>`,
    )
    .join("");
  $("pane-review").innerHTML =
    (review.length
      ? `<ul class="cards">${review.slice(0, MAX_ROWS / 2).map((r) => reviewCard(out, r, cut)).join("")}</ul>` +
        (review.length > MAX_ROWS / 2
          ? `<p class="blank">${(review.length - MAX_ROWS / 2).toLocaleString()} more are waiting. Raise the keep cutoff less, or read the JSON tab.</p>`
          : "")
      : `<p class="blank" data-testid="review-empty">Nothing is waiting. Every answer was clearly yes or clearly no.</p>`) +
    `<details class="dropped"><summary>Dropped <span class="count">${dropped.length}</span> · asked and answered no</summary>` +
    `<ul data-testid="dropped-list">${droppedRows}</ul></details>`;
}

// ---- json tab

function exportable(out: RunOutput): unknown {
  const r = out.result;
  return {
    entities: r.entities,
    relationships: r.relationships,
    review: r.review,
    metadata: r.metadata,
  };
}

function paintJson(out: RunOutput): void {
  $("json").textContent = JSON.stringify(exportable(out), null, 2);
}

/** Only the tab being looked at is built: the others wait until opened. */
function paintPane(tab: Tab, out: RunOutput): void {
  if (tab === "document") paintDocument(out);
  else if (tab === "links") paintLinks(out);
  else if (tab === "review") paintReview(out);
  else paintJson(out);
}

function paint(out: RunOutput): void {
  paintKinds(out.ontology);
  paintStats(out);
  paintGraph(out);
  $("n-links").textContent = String(out.result.relationships.length);
  $("n-review").textContent = String(out.result.review.length);
  const nav = $("n-review-nav");
  nav.hidden = out.result.review.length === 0;
  nav.textContent = String(out.result.review.length);
  paintPane(state.tab, out);
  pinned = null;
  showEvidence(null);
}

/** Show a (possibly partial) result. */
function show(out: RunOutput): void {
  state.last = out;
  paint(out);
}

function paintEmpty(message?: string): void {
  state.last = null;
  paintStats(null);
  graph.update([], []);
  $("pane-document").innerHTML = "";
  $("pane-links").innerHTML = "";
  $("pane-review").innerHTML = "";
  $("json").textContent = "";
  $("n-links").textContent = "0";
  $("n-review").textContent = "0";
  $("n-review-nav").hidden = true;
  $("graph-note").hidden = true;
  const empty = $("empty");
  empty.classList.remove("low");
  empty.hidden = message == null;
  if (message != null) empty.innerHTML = message;
}

// ---------------------------------------------------------------- wiring

function setTab(tab: Tab): void {
  state.tab = tab;
  document.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  });
  for (const t of ["document", "links", "review", "json"] as Tab[]) {
    $(`pane-${t}`).hidden = t !== tab;
  }
  if (state.last) paintPane(tab, state.last);
}

// ---- views: on a small screen the three panels are three pages

const compact = window.matchMedia("(max-width: 1100px)");

function showView(view: "inputs" | "graph" | "results"): void {
  $("grid").dataset.view = view;
  document.querySelectorAll<HTMLButtonElement>("#views button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.view === view));
  });
  if (view !== "inputs") window.scrollTo({ top: 0 });
}

async function validateYaml(): Promise<void> {
  const msg = $("yaml-msg");
  try {
    const info = await engine.validate(yamlEl.value);
    state.info = info;
    state.yamlValid = true;
    msg.className = "msg ok";
    msg.textContent = `✓ ${info.types.length} kinds · ${info.legal_pairs.length} legal links · ${info.listed_names} listed names`;
    paintKinds(info);
    refreshSuggestions();
    runSoon();
  } catch (e) {
    state.yamlValid = false;
    msg.className = "msg bad";
    msg.textContent = (e as Error).message;
  }
}

const validateSoon = debounce(() => void validateYaml(), 250);

function selectOntology(name: string): void {
  const file = state.ontologies.find((o) => o.name === name);
  if (!file) return;
  ontologyEl.value = name;
  yamlEl.value = file.yaml;
  void validateYaml();
}

function selectSample(id: string): void {
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) return;
  state.sample = id;
  textEl.value = sample.text;
  $("file-info").classList.remove("on");
  $("file-info").textContent = "or drop a .md / .txt file on the box";
  document.querySelectorAll<HTMLButtonElement>("#samples button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.sample === id));
  });
  $("sample-blurb").textContent = sample.blurb;
  if (ontologyEl.value !== sample.ontology) selectOntology(sample.ontology);
  else {
    refreshSuggestions();
    runSoon();
  }
}

// ---- upload, ontology tools, suggestions

const MAX_BYTES = 2_000_000;

function renderOntologyOptions(selected: string): void {
  ontologyEl.innerHTML =
    state.ontologies
      .map((o) => {
        const blurb = ONTOLOGY_BLURBS[o.name];
        return `<option value="${esc(o.name)}">${esc(o.name)}${blurb ? ` · ${esc(blurb)}` : ""}</option>`;
      })
      .join("") + `<option value="custom">custom (edited)</option>`;
  ontologyEl.value = selected;
}

function setTextMessage(message: string, bad = false): void {
  const box = $("text-msg");
  box.textContent = message;
  box.className = bad ? "msg bad" : "msg";
}

/** Read a dropped or chosen file as text. Returns null (and says why) if it is not text. */
async function readTextFile(file: File, what: string): Promise<string | null> {
  if (/\.(pdf|docx?|pptx?|xlsx?|png|jpe?g|gif|zip)$/i.test(file.name)) {
    setTextMessage(
      `${file.name}: ${what} must be plain text or markdown. Convert PDF or Word files to markdown first.`,
      true,
    );
    return null;
  }
  if (file.size > MAX_BYTES) {
    setTextMessage(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB. This demo reads files up to 2 MB.`, true);
    return null;
  }
  const text = await file.text();
  if (text.includes("\u0000")) {
    setTextMessage(`${file.name} does not look like a text file.`, true);
    return null;
  }
  return text;
}

async function loadDocument(file: File): Promise<void> {
  const text = await readTextFile(file, "A document");
  if (text == null) return;
  textEl.value = text;
  state.sample = "upload";
  document.querySelectorAll<HTMLButtonElement>("#samples button").forEach((b) => b.setAttribute("aria-pressed", "false"));
  const words = (text.match(/\S+/g) ?? []).length;
  const info = $("file-info");
  info.textContent = `${file.name} · ${(file.size / 1000).toFixed(1)} KB · ${words.toLocaleString()} words`;
  info.classList.add("on");
  $("sample-blurb").textContent = "Your own document. Pick or write an ontology for it, then add the names it should know.";
  setTextMessage("");
  refreshSuggestions();
  runSoon();
}

async function loadOntologyFile(file: File): Promise<void> {
  const text = await readTextFile(file, "An ontology");
  if (text == null) return;
  const name = file.name.replace(/\.[^.]+$/, "") || "uploaded";
  const existing = state.ontologies.find((o) => o.name === name);
  if (existing) existing.yaml = text;
  else state.ontologies.push({ name, yaml: text });
  renderOntologyOptions(name);
  yamlEl.value = text;
  $("yaml-wrap").hidden = false;
  $("toggle-yaml").setAttribute("aria-expanded", "true");
  $("toggle-yaml").textContent = "Hide YAML";
  await validateYaml();
  if (!state.yamlValid) ontologyEl.value = "custom";
}

function newOntology(): void {
  yamlEl.value = state.starter;
  ontologyEl.value = "custom";
  $("yaml-wrap").hidden = false;
  $("toggle-yaml").setAttribute("aria-expanded", "true");
  $("toggle-yaml").textContent = "Hide YAML";
  void validateYaml();
}

function refreshSuggestions(): void {
  const info = state.info;
  const box = $("suggest");
  if (!info) {
    box.hidden = true;
    return;
  }
  const found = suggestNames(textEl.value, info.gazetteer);
  box.hidden = found.length === 0;
  const select = $<HTMLSelectElement>("suggest-type");
  const keep = select.value;
  select.innerHTML = info.types.map((t) => `<option value="${esc(t.id)}">${esc(human(t.id))}</option>`).join("");
  if (info.types.some((t) => t.id === keep)) select.value = keep;
  $("suggest-chips").innerHTML = found
    .map(
      (c) =>
        `<button type="button" data-name="${esc(c.name)}" data-testid="suggestion" title="Add to the ontology's list">${esc(c.name)}${c.count > 1 ? `<b>×${c.count}</b>` : ""}</button>`,
    )
    .join("");
}

const refreshSoon = debounce(refreshSuggestions, 250);

function addNames(names: string[]): void {
  const type = $<HTMLSelectElement>("suggest-type").value;
  let yaml = yamlEl.value;
  for (const n of names) yaml = addToGazetteer(yaml, n, type);
  yamlEl.value = yaml;
  ontologyEl.value = "custom";
  void validateYaml();
}

function wireUploads(): void {
  $("file").addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) void loadDocument(f);
    input.value = ""; // allow choosing the same file again
  });
  $("yaml-file").addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) void loadOntologyFile(f);
    input.value = "";
  });
  for (const target of [textEl, yamlEl]) {
    target.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      target.classList.add("drop");
    });
    target.addEventListener("dragleave", () => target.classList.remove("drop"));
    target.addEventListener("drop", (ev) => {
      ev.preventDefault();
      target.classList.remove("drop");
      const f = ev.dataTransfer?.files?.[0];
      if (!f) return;
      void (target === textEl ? loadDocument(f) : loadOntologyFile(f));
    });
  }
  $("new-ontology").addEventListener("click", newOntology);
  $("download-yaml").addEventListener("click", () => {
    const blob = new Blob([yamlEl.value], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.info?.id ?? "ontology"}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("suggest-chips").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-name]");
    if (b?.dataset.name) addNames([b.dataset.name]);
  });
  $("suggest-all").addEventListener("click", () => {
    const names = [...document.querySelectorAll<HTMLButtonElement>("#suggest-chips button")].map((b) => b.dataset.name ?? "");
    addNames(names.filter(Boolean));
  });
}

function wire(): void {
  wireUploads();
  const chips = $("samples");
  chips.innerHTML = SAMPLES.map(
    (s) =>
      `<button type="button" data-sample="${s.id}" data-testid="sample-${s.id}" aria-pressed="false">${esc(s.label)}</button>`,
  ).join("");
  chips.insertAdjacentHTML("afterend", `<p class="blurb" id="sample-blurb" data-testid="sample-blurb"></p>`);
  chips.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-sample]");
    if (b?.dataset.sample) selectSample(b.dataset.sample);
  });

  textEl.addEventListener("input", () => {
    document.querySelectorAll<HTMLButtonElement>("#samples button").forEach((b) => b.setAttribute("aria-pressed", "false"));
    $("sample-blurb").textContent = "Your own text. Edit freely, then press Extract graph.";
    state.sample = "note";
    $("file-info").classList.remove("on");
    $("file-info").textContent = "or drop a .md / .txt file on the box";
    refreshSoon();
    // Typing never calls the model by itself: it is a real model with a real cost.
    $("run-note").textContent = "Text changed. Press Extract graph to read it again.";
  });

  ontologyEl.addEventListener("change", () => selectOntology(ontologyEl.value));
  yamlEl.addEventListener("input", () => {
    ontologyEl.value = "custom";
    validateSoon();
  });
  $("toggle-yaml").addEventListener("click", () => {
    const wrap = $("yaml-wrap");
    wrap.hidden = !wrap.hidden;
    $("toggle-yaml").setAttribute("aria-expanded", String(!wrap.hidden));
    $("toggle-yaml").textContent = wrap.hidden ? "Edit YAML" : "Hide YAML";
  });

  const onCut = (which: "keep" | "drop") => () => {
    let { keep, drop } = cutoffs();
    // The two cutoffs may not cross; the one being moved pushes the other away.
    if (which === "keep" && keep - drop < 0.05) drop = Math.max(0.01, keep - 0.05);
    if (which === "drop" && keep - drop < 0.05) keep = Math.min(0.99, drop + 0.05);
    keepEl.value = String(keep);
    dropEl.value = String(drop);
    paintBands();
    // Moving a cutoff re-reads the cached answers: no new model call.
    if (state.last) regateSoon();
  };
  keepEl.addEventListener("input", onCut("keep"));
  dropEl.addEventListener("input", onCut("drop"));

  $("run").addEventListener("click", () => void run({ consent: false }));
  $("stop").addEventListener("click", stopReading);
  $("continue").addEventListener("click", () => void resume());
  $("retry").addEventListener("click", () => void resume());
  $("plan-preview").addEventListener("click", () => {
    const limit = Number(($("plan-preview") as HTMLElement).dataset.limit) || 1;
    hidePlan();
    void startReading(limit);
  });
  $("plan-all").addEventListener("click", () => {
    hidePlan();
    void startReading();
  });
  document.querySelectorAll<HTMLButtonElement>("#views [data-view]").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view as "inputs" | "graph" | "results"));
  });
  // Cached answers belong to one (host, model) pair; a new target starts clean.
  for (const id of ["host-url", "host-model"]) {
    $(id).addEventListener("input", () => {
      void engine.clearCache();
      $("run-note").textContent = "Host changed. Press Extract graph to ask it.";
    });
  }

  document.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]").forEach((b) => {
    b.addEventListener("click", () => setTab(b.dataset.tab as Tab));
  });

  $("copy-json").addEventListener("click", async () => {
    await navigator.clipboard?.writeText($("json").textContent ?? "");
    $("copy-json").textContent = "Copied";
    setTimeout(() => ($("copy-json").textContent = "Copy"), 1200);
  });
  $("download-json").addEventListener("click", () => {
    const blob = new Blob([$("json").textContent ?? ""], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "graph.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  new ResizeObserver(() => graph.refit()).observe($("graph"));
}

async function wasmSize(): Promise<string> {
  try {
    const res = await fetch(wasmUrl, { method: "HEAD" });
    const n = Number(res.headers.get("content-length"));
    return n ? `${(n / 1_000_000).toFixed(1)} MB` : "";
  } catch {
    return "";
  }
}

/** `?host=http://…&model=…` pre-fills the decision model, so a link can point at any host. */
function useQueryHost(): void {
  const q = new URLSearchParams(location.search);
  const host = q.get("host");
  const model = q.get("model");
  if (host) $<HTMLInputElement>("host-url").value = host;
  if (model) $<HTMLInputElement>("host-model").value = model;
}

async function boot(): Promise<void> {
  wire();
  paintBands();
  setTab("document");
  try {
    const { ontologies, starter, version } = await engine.init();
    state.starter = starter;
    state.ontologies = [...ontologies, ...DEMO_ONTOLOGIES];
    renderOntologyOptions(SAMPLES[0].ontology);
    const size = await wasmSize();
    $("wasm-status").textContent = `engine ready · v${version}${size ? ` · ${size} wasm` : ""}`;
    $("wasm-dot").classList.add("ok");
    document.body.dataset.ready = "true";
    useQueryHost();
    selectOntology(SAMPLES[0].ontology);
    selectSample(SAMPLES[0].id);
  } catch (e) {
    $("wasm-status").textContent = "engine failed to load";
    showError((e as Error).message);
  }
}

void boot();
