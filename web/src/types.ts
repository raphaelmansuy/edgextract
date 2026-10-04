// Shapes returned by the Rust crate (`edgextract-wasm`). Kept small and explicit.

export interface OntologyFile {
  name: string;
  yaml: string;
}

export interface OntologyType {
  id: string;
  description: string;
  color: string;
}

export interface OntologyRelation {
  id: string;
  description: string;
  domain: string[];
  range: string[];
}

export interface OntologyInfo {
  id: string;
  title: string;
  types: OntologyType[];
  relations: OntologyRelation[];
  legal_pairs: string[];
  listed_names: number;
  gazetteer: string[];
}

export interface Sentence {
  id: string;
  text: string;
  start: number; // UTF-8 byte offsets into the original text
  end: number;
  heading_path: string[];
}

export interface Entity {
  name: string;
  entity_type: string;
  description: string;
  importance: number;
  source_spans: string[];
  display_name: string | null;
}

export interface Relationship {
  source: string;
  target: string;
  relation_type: string;
  description: string; // the evidence sentence
  weight: number;
}

export type Band = "ACCEPT" | "REVIEW" | "REJECT";

export interface TypedMention {
  mention: { text: string; start: number; end: number; sentence_id: string };
  entity_type: string;
  band: Band;
  winner_prob: number;
  decided_by: string;
}

/** A review or rejected item. `kind` tells a name from a link. */
export interface Flagged {
  kind: "entity" | "relation";
  band: Band;
  prob: number;
  sentence_id: string;
  // entity items
  text?: string;
  type?: string;
  // relation items
  source?: string;
  target?: string;
  asked?: string;
  reason?: string;
}

export interface Stats {
  sentences: number;
  mentions_proposed: number;
  pairs_considered: number;
  systemone_calls: number;
  cache_hits: number;
  questions_inferred: number;
  questions_from_cache: number;
  input_tokens: number;
  output_tokens: number;
  elapsed_ms: number;
  decision_wall_ms: number;
}

export interface ExtractionResult {
  entities: Entity[];
  relationships: Relationship[];
  review: Flagged[];
  rejected: Flagged[];
  mentions: TypedMention[];
  metadata: { model: string; ontology_id: string; stats: Stats };
}

/** Where a document is in being read, section by section. */
export interface Progress {
  section: number;
  sections: number;
  sentences_done: number;
  sentences: number;
  calls: number;
  cache_hits: number;
  /** Milliseconds spent reading so far, not counting time paused. */
  work_ms: number;
  done: boolean;
}

/** What a document will cost, known before the model is asked anything. */
export interface Plan {
  sentences: number;
  sections: number;
  /** Sections in the whole document, even when only the first few will be read. */
  total_sections: number;
  forecast: { unknown_names: number; typing_calls: number; estimated_calls: number };
  progress: Progress;
}

export interface RunOutput {
  result: ExtractionResult;
  sentences: Sentence[];
  ontology: OntologyInfo;
  cache_entries: number;
  progress: Progress;
}

export interface RunRequest {
  text: string;
  ontology_yaml: string;
  model?: string;
  document_id?: string;
  gate: { noul_yes: number; noul_no: number };
  /** Also ask the model about capitalized runs the ontology does not list. */
  discover_names?: boolean;
  /** Read only the first N sections. */
  max_sections?: number;
}

/** Where closed questions are answered. */
export type DecisionBackend = "ollama" | "webgpu";

export interface HostConfig {
  backend: DecisionBackend;
  /** Ollama (or stand-in) base URL. Ignored for WebGPU. */
  baseUrl: string;
  /** Model name for Ollama, or ONNX model id for WebGPU. */
  model: string;
}

export type WorkerIn =
  | { id: number; kind: "init" }
  | { id: number; kind: "validate"; yaml: string }
  | { id: number; kind: "prepare"; request: RunRequest; host: HostConfig }
  | { id: number; kind: "run"; limit?: number }
  | { id: number; kind: "stop" }
  | { id: number; kind: "clear" }
  | { id: number; kind: "webgpu-probe" }
  | { id: number; kind: "webgpu-mock"; enabled: boolean }
  | { id: number; kind: "webgpu-load"; modelId: string }
  | { id: number; kind: "webgpu-bench" };

export type WorkerOut =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; partial?: RunOutput }
  | { id: number; kind: "progress"; progress: Progress; output: RunOutput | null }
  | {
      id: 0;
      kind: "call";
      state: "start" | "end";
      n: number;
      ms?: number;
      prefillMs?: number;
      questions?: number;
      forwards?: number;
      packPath?: string;
    }
  | { id: 0; kind: "webgpu-progress"; message: string; frac?: number };
