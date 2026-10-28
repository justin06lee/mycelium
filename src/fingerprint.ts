import { createHash } from "node:crypto";
import { ts } from "ts-morph";
import type { Chunk, Fingerprint, Slice } from "./types.ts";

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Code as a token stream, so comments and formatting never count as a change. */
export function codeTokens(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, text);
  const out: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) out.push(scanner.getTokenText());
  return out;
}

export function normalizeStyle(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
}

export function fingerprint(slice: Slice): Fingerprint {
  const files: Record<string, string> = {};
  for (const c of slice.chunks) files[c.file] = c.hash;
  const all = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, h]) => `${f}:${h}`)
    .join("\n");
  return { hash: hash(all), files, shape: slice.shape, rootText: slice.rootText };
}

export interface Drift {
  changed: string[];
  added: string[];
  removed: string[];
}

export function drift(before: Fingerprint, chunks: Chunk[]): Drift {
  const now = new Map(chunks.map((c) => [c.file, c.hash]));
  const d: Drift = { changed: [], added: [], removed: [] };
  for (const [file, h] of now) {
    if (!(file in before.files)) d.added.push(file);
    else if (before.files[file] !== h) d.changed.push(file);
  }
  for (const file of Object.keys(before.files)) if (!now.has(file)) d.removed.push(file);
  return d;
}

/** Dice coefficient over token bigrams: 1 for identical code, near 0 for unrelated code. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.split(" ");
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) {
      const g = `${t[i]} ${t[i + 1]}`;
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of ga) {
    overlap += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}
