import type { Town } from '../geo/region';

const ABBREV: Record<string, string> = { k: 'kuala', kg: 'kampung', kpg: 'kampung', kb: 'kota bharu', tg: 'tanjung', tnh: 'tanah', ps: 'pasir' };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((w) => (ABBREV[w] ?? w).split(' '));

/** Local fuzzy place match until Workstream C's Atlas Search (/search?type=place) is wired in. */
export function matchPlaces(query: string, towns: Town[], limit = 5): Town[] {
  const q = norm(query);
  if (!q.length) return [];
  const qCompact = q.join('');
  return towns
    .map((town) => {
      const words = norm(town.name);
      const compact = words.join('');
      let score = 0;
      if (q.every((w) => words.some((n) => n.startsWith(w)))) score += 3;
      if (compact.includes(qCompact)) score += 2;
      // Tolerate one typo per word ("kuala kri").
      if (q.every((w) => words.some((n) => typoClose(n, w)))) score += 1;
      return { town, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.town);
}

function typoClose(word: string, q: string): boolean {
  if (q.length < 3) return word.startsWith(q);
  const w = word.slice(0, q.length + 1);
  // Levenshtein distance ≤ 1 against the word's prefix.
  const a = w;
  const b = q;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  let best = Infinity;
  for (let i = Math.max(0, b.length - 1); i <= a.length; i++) best = Math.min(best, dp[i][b.length]);
  return best <= 1;
}
