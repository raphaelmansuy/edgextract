import { demoNote } from "./ontologies";

// The notes are the repository's own golden files, so the demo shows the same
// inputs the Rust and Python tests use.

const files = import.meta.glob("../../data/golden/docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function golden(name: string): string {
  const hit = Object.entries(files).find(([path]) => path.endsWith(`/${name}.md`));
  if (!hit) throw new Error(`missing sample ${name}`);
  return hit[1];
}

export interface Sample {
  id: string;
  label: string;
  ontology: string;
  blurb: string;
  text: string;
}

export const SAMPLES: Sample[] = [
  {
    id: "northwind",
    label: "Northwind",
    ontology: "company_news",
    blurb: "Four sentences of company news. “Acme invested in Northwind” points one way only.",
    text: golden("13_northwind"),
  },
  {
    id: "unknown",
    label: "New names",
    ontology: "company_news",
    blurb: "Orion Labs is not on the ontology's list, so the model is asked, and it is unsure.",
    text:
      "# Funding round\n\n" +
      "Ada Lovelace founded Northwind in Paris.\n" +
      "**Orion Labs** invested in Northwind.\n" +
      "Acme Inc might acquire Northwind next year.\n" +
      "Jane Doe never worked for Acme Inc.\n",
  },
  {
    id: "acquired",
    label: "Who bought whom",
    ontology: "company_news",
    blurb: "Acme bought Northwind; Ada still works for Northwind.",
    text: golden("14_acquired"),
  },
  {
    id: "edgequake",
    label: "Tech docs",
    ontology: "tech_docs",
    blurb: "Software documentation: products, databases, people, places.",
    text: golden("01_edgequake"),
  },
  {
    id: "negation",
    label: "Negation",
    ontology: "tech_docs",
    blurb: "“Acme does not use EdgeQuake.” A negated link is a no, not a yes.",
    text: golden("05_negation"),
  },
  {
    id: "hedge",
    label: "Hedging",
    ontology: "tech_docs",
    blurb: "“might”, “could”: possibility is not fact, so those go to a person.",
    text: golden("12_hedge"),
  },
  {
    id: "pronouns",
    label: "Pronouns",
    ontology: "tech_docs",
    blurb: "“She”, “They”, “It” are never turned into names.",
    text: golden("10_pronouns"),
  },
  {
    id: "fence",
    label: "Code fence",
    ontology: "tech_docs",
    blurb: "Names inside a code fence are examples, not facts.",
    text: golden("06_fence"),
  },
  {
    id: "papers",
    label: "Research paper",
    ontology: "research_papers",
    blurb: "A different domain, a different ontology: papers, methods and datasets.",
    text: demoNote("research_papers"),
  },
  {
    id: "film",
    label: "Film",
    ontology: "movies",
    blurb: "“Produced by” reads right to left. The passive voice is handled.",
    text: demoNote("movies"),
  },
  {
    id: "medicine",
    label: "Medicine",
    ontology: "biomedical",
    blurb: "Drugs, diseases and genes. “Does not treat” is a no.",
    text: demoNote("biomedical"),
  },
  {
    id: "history",
    label: "History",
    ontology: "history",
    blurb: "People, places and events from a short history note.",
    text: demoNote("history"),
  },
];
