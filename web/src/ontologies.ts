import type { OntologyFile } from "./types";

// Extra sample ontologies, shipped with the demo. The three that live in the Rust
// crate (company_news, tech_docs, conll04) come from the wasm module itself.
const yaml = import.meta.glob("./ontologies/*.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const notes = import.meta.glob("./ontologies/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const stem = (path: string): string => path.split("/").pop()!.replace(/\.[^.]+$/, "");

export const DEMO_ONTOLOGIES: OntologyFile[] = Object.entries(yaml)
  .map(([path, text]) => ({ name: stem(path), yaml: text }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function demoNote(name: string): string {
  const hit = Object.entries(notes).find(([path]) => stem(path) === name);
  if (!hit) throw new Error(`missing sample note for ${name}`);
  return hit[1];
}

/** One-line plain-English description for the picker. */
export const ONTOLOGY_BLURBS: Record<string, string> = {
  company_news: "people, companies, places",
  tech_docs: "software docs",
  conll04: "news benchmark",
  research_papers: "papers, methods, datasets",
  movies: "films, people, studios",
  biomedical: "drugs, diseases, genes",
  history: "people, events, places",
};
