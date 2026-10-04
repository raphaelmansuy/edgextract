// Helpers for getting an arbitrary document to work with an ontology.
//
// edgextract finds names from the ontology's own list, from markdown cues, or from
// an optional span finder. So a brand-new document usually needs its names added to
// the list. These helpers find likely names and write them into the YAML.

const SKIP_WORDS = new Set(
  (
    "a an the this that these those it its they them their he she his her we our you your i " +
    "in on at of for to from by with and or but if as is are was were be been being " +
    "after before when while then there here also however though although because since until " +
    "not no yes all any some each every both many most other another such what which who whom " +
    "one two three first second third new old more less last next today yesterday tomorrow " +
    "january february march april may june july august september october november december " +
    "monday tuesday wednesday thursday friday saturday sunday"
  ).split(" "),
);

const CONNECTORS = new Set(["of", "the", "de", "van", "von", "da", "del", "and", "for"]);

/** Remove fenced code and the names the ontology already lists. */
function mask(text: string, listed: string[]): string {
  let out = text.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
  const names = [...listed].sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!name) continue;
    const rx = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(rx, (m) => " ".repeat(m.length));
  }
  return out;
}

export interface Candidate {
  name: string;
  count: number;
}

/** Capitalized runs ("Orion Labs", "Battle of Waterloo") that are not already listed. */
export function suggestNames(text: string, listed: string[], limit = 14): Candidate[] {
  const masked = mask(text, listed);
  const word = /[\p{Lu}][\p{L}\p{N}'’\-]*|[\p{Ll}]+|[\p{N}]+/gu;
  const tokens: { t: string; i: number; sentenceStart: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = word.exec(masked))) {
    const before = masked.slice(0, m.index).replace(/[ \t*_`#>\-]+$/, "");
    const sentenceStart = before === "" || /[.!?:\n]$/.test(before);
    tokens.push({ t: m[0], i: m.index, sentenceStart });
  }
  const found = new Map<string, { count: number; opening: number }>();
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!/^[\p{Lu}]/u.test(tok.t)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < tokens.length) {
      const next = tokens[j + 1];
      const gap = masked.slice(tokens[j].i + tokens[j].t.length, next.i);
      if (!/^[ \t]+$/.test(gap)) break; // only plain spaces join words
      if (/^[\p{Lu}]/u.test(next.t)) {
        j++;
        continue;
      }
      // "Battle of Waterloo": a lowercase connector between two capitalized words.
      const after = tokens[j + 2];
      if (
        CONNECTORS.has(next.t) &&
        after &&
        /^[\p{Lu}]/u.test(after.t) &&
        /^[ \t]+$/.test(masked.slice(next.i + next.t.length, after.i))
      ) {
        j += 2;
        continue;
      }
      break;
    }
    const parts = tokens.slice(i, j + 1).map((x) => x.t);
    // A stop-word is only capitalized because it opens a sentence.
    const hadOpener = parts.length > 0 && SKIP_WORDS.has(parts[0].toLowerCase());
    while (parts.length && SKIP_WORDS.has(parts[0].toLowerCase())) parts.shift();
    const name = parts.join(" ").replace(/\s+/g, " ").trim();
    if (name.length >= 2 && !SKIP_WORDS.has(name.toLowerCase())) {
      const opening = tok.sentenceStart && !hadOpener ? 1 : 0;
      const prev = found.get(name) ?? { count: 0, opening: 0 };
      found.set(name, { count: prev.count + 1, opening: prev.opening + opening });
    }
    i = j + 1;
  }
  return [...found.entries()]
    .filter(([name, f]) => name.includes(" ") || f.count > f.opening || f.count > 1)
    .map(([name, f]) => ({ name, count: f.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

const yamlKey = (name: string): string =>
  /^[A-Za-z0-9][\w .\-']*$/.test(name) && !/^(true|false|null|yes|no|on|off)$/i.test(name) && !name.endsWith(" ")
    ? name
    : JSON.stringify(name);

/** Add `name: TYPE` under `gazetteer:`, creating the section if needed. */
export function addToGazetteer(yaml: string, name: string, type: string): string {
  const line = `  ${yamlKey(name)}: ${type}`;
  const lines = yaml.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((l) => /^gazetteer\s*:/.test(l));
  if (at < 0) return `${lines.join("\n")}\ngazetteer:\n${line}\n`;
  if (/^gazetteer\s*:\s*(\{\s*\}|null|~)\s*(#.*)?$/.test(lines[at])) {
    lines[at] = "gazetteer:";
  }
  // The section ends at the next top-level key.
  let end = at + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]) || lines[end].startsWith("#"))) end++;
  // Skip trailing blank lines inside the block so the new line hugs the last entry.
  let insert = end;
  while (insert - 1 > at && lines[insert - 1] === "") insert--;
  lines.splice(insert, 0, line);
  return `${lines.join("\n")}\n`;
}
