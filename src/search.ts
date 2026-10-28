import type { Entry } from "./types.ts";

/** Splits names, paths and prose alike: "SettingsDialog" and "settings-dialog" give the same words. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const FIELDS: { weight: number; get: (e: Entry) => string[] }[] = [
  { weight: 10, get: (e) => [e.name, ...e.aliases] },
  { weight: 8, get: (e) => [e.slug] },
  { weight: 6, get: (e) => e.tags },
  { weight: 5, get: (e) => [e.root.symbol] },
  { weight: 4, get: (e) => [e.note] },
  { weight: 2, get: (e) => [e.root.file, ...e.pins] },
];

export function search(entries: Entry[], query: string): { entry: Entry; score: number }[] {
  const terms = words(query);
  const phrase = query.trim().toLowerCase();
  if (terms.length === 0) return [];
  const results: { entry: Entry; score: number }[] = [];
  for (const entry of entries) {
    const fields = FIELDS.map((f) => ({ weight: f.weight, words: f.get(entry).flatMap(words) }));
    let score = 0;
    let missed = 0;
    for (const t of terms) {
      let best = 0;
      for (const f of fields) {
        for (const w of f.words) {
          const s = w === t ? f.weight : w.startsWith(t) ? f.weight * 0.6 : t.length > 2 && w.includes(t) ? f.weight * 0.3 : 0;
          best = Math.max(best, s);
        }
      }
      if (best === 0) missed++;
      score += best;
    }
    if (score === 0) continue;
    if ([entry.name, ...entry.aliases].some((n) => n.toLowerCase().includes(phrase))) score += 20;
    score *= 0.5 ** missed;
    results.push({ entry, score: Math.round(score * 10) / 10 });
  }
  return results.sort((a, b) => b.score - a.score);
}
