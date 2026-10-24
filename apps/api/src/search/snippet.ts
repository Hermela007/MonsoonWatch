// Pure: pick the passage of a knowledge chunk that best matches the query, trimmed for the results panel.
// Sentences are scored by how many distinct query words (≥ 3 letters) they contain; the best one is
// widened with its neighbours up to `maxChars`. Ellipses mark text cut from either end.

// A sentence ends at . ! ? (plus closing quotes/brackets) followed by whitespace, so "26.8 m" stays whole.
const SENTENCE_END = /(?<=[.!?]["')\]]*)\s+/;

function words(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
}

export function snippet(chunk: string, query: string, maxChars = 280): string {
  const text = chunk.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const sentences = text.split(SENTENCE_END).filter(Boolean);
  const terms = new Set(words(query));
  let best = 0;
  let bestScore = -1;
  sentences.forEach((s, i) => {
    const score = new Set(words(s).filter((w) => terms.has(w))).size;
    if (score > bestScore) [best, bestScore] = [i, score];
  });
  let from = best;
  let to = best;
  const len = () => sentences.slice(from, to + 1).join(" ").length;
  // Grow forward first (context usually follows the matching sentence), then backward.
  while (true) {
    if (to + 1 < sentences.length && len() + 1 + sentences[to + 1]!.length <= maxChars) to++;
    else if (from > 0 && len() + 1 + sentences[from - 1]!.length <= maxChars) from--;
    else break;
  }
  let out = sentences.slice(from, to + 1).join(" ");
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).replace(/\s+\S*$/, "") + "…";
  return (from > 0 ? "…" : "") + out + (to < sentences.length - 1 && !out.endsWith("…") ? " …" : "");
}
