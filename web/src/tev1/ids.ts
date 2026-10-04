/**
 * Token-id helpers for packed Tev1 prefills (prefix KV reuse).
 */

/** Longest shared prefix across tokenized prompts. */
export function commonPrefixLength(seqs: number[][]): number {
  if (seqs.length === 0) return 0;
  let n = seqs[0]!.length;
  for (let i = 1; i < seqs.length; i++) {
    const a = seqs[i]!;
    const m = Math.min(n, a.length);
    let k = 0;
    while (k < m && a[k] === seqs[0]![k]) k++;
    n = k;
    if (n === 0) return 0;
  }
  // Leave at least one suffix token on the shortest sequence.
  const shortest = Math.min(...seqs.map((s) => s.length));
  return Math.min(n, Math.max(0, shortest - 1));
}

export function flattenTokenIds(data: ArrayLike<number | bigint>): number[] {
  const out = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number(data[i]);
  return out;
}
