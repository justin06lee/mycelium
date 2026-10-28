import { drift, type Drift, fingerprint, similarity } from "./fingerprint.ts";
import type { Store } from "./store.ts";
import type { Candidate, Entry, RootRef, Slice, Workspace } from "./types.ts";

export type Status = "ok" | "new" | "changed" | "relinked" | "orphaned";

export interface Relink {
  from: RootRef;
  how: "moved" | "renamed" | "similar";
  score?: number;
}

export interface Resolved {
  entry: Entry;
  status: Status;
  root: RootRef;
  slice?: Slice;
  drift?: Drift;
  relink?: Relink;
  /** Slugs of registered components this one renders. */
  uses: string[];
  /** Files that import it, with the component each belongs to when it is registered. */
  usedBy: { file: string; slug?: string }[];
}

const key = (r: RootRef) => `${r.file}#${r.symbol}`;
const FUZZY_MIN = 0.6;

/** The registry read against the code as it is now. */
export class Library {
  private candidates: Candidate[];
  private located = new Map<string, { root?: RootRef; relink?: Relink }>();

  constructor(
    readonly ws: Workspace,
    readonly store: Store,
    readonly entries: Entry[] = store.all(),
  ) {
    this.candidates = ws.discover();
    this.locateAll();
  }

  /** Finds every entry's root, following renames and moves the way git follows renamed files. */
  private locateAll(): void {
    const exists = new Set(this.candidates.map(key));
    const claimed = new Set<string>();
    const lost: Entry[] = [];
    for (const e of this.entries) {
      if (exists.has(key(e.root))) {
        this.located.set(e.slug, { root: e.root });
        claimed.add(key(e.root));
      } else lost.push(e);
    }
    const free = () => this.candidates.filter((c) => !claimed.has(key(c)));
    const claim = (e: Entry, root: RootRef, how: Relink["how"], score?: number) => {
      const r = { file: root.file, symbol: root.symbol };
      this.located.set(e.slug, { root: r, relink: { from: e.root, how, score } });
      claimed.add(key(r));
    };
    for (const e of lost) {
      const sameName = free().filter((c) => c.symbol === e.root.symbol && c.symbol !== "default");
      if (sameName.length === 1) {
        claim(e, sameName[0]!, "moved");
        continue;
      }
      const fp = e.fingerprint;
      if (!fp) {
        this.located.set(e.slug, {});
        continue;
      }
      const shapes = free().map((c) => ({ c, s: this.ws.rootShape(c) }));
      const exact = shapes.filter(({ s }) => s?.shape === fp.shape);
      if (exact.length === 1) {
        claim(e, exact[0]!.c, "renamed");
        continue;
      }
      let best: { c: Candidate; score: number } | undefined;
      for (const { c, s } of shapes) {
        if (!s) continue;
        const score = similarity(fp.rootText, s.rootText) + (c.file === e.root.file ? 0.05 : 0);
        if (!best || score > best.score) best = { c, score };
      }
      if (best && best.score >= FUZZY_MIN) claim(e, best.c, "similar", Math.min(1, Math.round(best.score * 100) / 100));
      else this.located.set(e.slug, {});
    }
  }

  resolve(slug: string): Resolved | undefined {
    const entry = this.entries.find((e) => e.slug === slug);
    if (!entry) return undefined;
    const { root, relink } = this.located.get(slug) ?? {};
    if (!root) return { entry, status: "orphaned", root: entry.root, uses: [], usedBy: [] };

    const others = this.entries
      .filter((e) => e.slug !== slug)
      .map((e) => ({ slug: e.slug, root: this.located.get(e.slug)?.root ?? e.root }));
    const slice = this.ws.slice(root, { boundaries: others.map((o) => o.root), pins: entry.pins });
    if (!slice) return { entry, status: "orphaned", root: entry.root, uses: [], usedBy: [] };

    const bySlugRoot = new Map(others.map((o) => [key(o.root), o.slug]));
    const byFile = new Map(others.map((o) => [o.root.file, o.slug]));
    const uses = slice.uses.map((u) => bySlugRoot.get(key(u))).filter((s): s is string => !!s);
    const usedBy = this.ws.usedBy(root).map((file) => ({ file, slug: byFile.get(file) }));

    const fp = entry.fingerprint;
    const d = fp ? drift(fp, slice.chunks) : undefined;
    const same = fp ? fingerprint(slice).hash === fp.hash : false;
    const status: Status = relink ? "relinked" : !fp ? "new" : same ? "ok" : "changed";
    return { entry, status, root, slice, drift: same ? undefined : d, relink, uses: [...new Set(uses)], usedBy };
  }

  resolveAll(): Resolved[] {
    return this.entries.map((e) => this.resolve(e.slug)!);
  }

  /** Records what the code looks like now, so the next check measures from here. */
  record(r: Resolved): Entry {
    if (!r.slice) return r.entry;
    const entry: Entry = {
      ...r.entry,
      root: { file: r.root.file, symbol: r.slice.root.symbol },
      fingerprint: fingerprint(r.slice),
      updatedAt: new Date().toISOString(),
    };
    this.store.put(entry);
    return entry;
  }

  /** Components in the code that aren't in the library yet. */
  unregistered(includeInternal = false): Candidate[] {
    const taken = new Set([...this.located.values()].map((l) => l.root && key(l.root)));
    return this.candidates.filter((c) => !taken.has(key(c)) && (includeInternal || c.exported));
  }

  allCandidates(): Candidate[] {
    return this.candidates;
  }
}
