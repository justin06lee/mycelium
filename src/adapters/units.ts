import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { hash, normalizeStyle } from "../fingerprint.ts";
import type { Candidate, Chunk, RootRef, Slice, SliceOptions, Workspace } from "../types.ts";
import type { Syntax } from "./grammars.ts";
import { tokens } from "./grammars.ts";

/**
 * One top-level declaration. Languages whose files share one scope (a Go package, a Swift module) are sliced in
 * declarations rather than files, since any file can use any other's names without importing them.
 */
export interface Unit {
  file: UnitFile;
  kind: string;
  /** The declared name; a member of a type is Type.member. */
  name: string;
  /** Every name the declaration binds; names[0] is the one its shape blanks out. */
  names: string[];
  node: Syntax;
  /** 1-based lines, doc comment included. */
  from: number;
  to: number;
  /** Where the declaration itself starts. */
  line: number;
}

/** What a file is made of, in order (package clause, imports, units), so kept ones can be cut into ranges. */
export interface Item {
  from: number;
  to: number;
  unit?: Unit;
  import?: boolean;
}

export interface UnitFile {
  abs: string;
  rel: string;
  text: string;
  tree: Syntax;
  items: Item[];
  units: Unit[];
}

/** The slicing every declaration-based adapter shares; each language says what its units refer to. */
export abstract class UnitWorkspace<U extends Unit, F extends UnitFile> implements Workspace {
  protected files = new Map<string, F>();
  private reverse?: Map<U, Set<U>>;

  constructor(readonly root: string) {}

  abstract discover(): Candidate[];
  /** The units a unit refers to. */
  protected abstract refsOf(u: U): Set<U>;
  /** A type comes with its methods or extensions; anything else is itself. */
  protected abstract members(u: U): U[];
  /** The type a unit is or belongs to, as a key: a root's sibling members aren't cut off as another component's. */
  protected abstract ownerOf(u: U): string | undefined;
  /** Does the unit use anything its file imports, so the imports belong in its chunk? */
  protected abstract usesImports(u: U): boolean;
  /** Units that come along with the roots without being referred to, such as a SwiftUI view's previews. */
  protected companions(_roots: Set<U>): U[] {
    return [];
  }
  /** Whether a unit's references make it a user of what it refers to; previews, like tests, don't. */
  protected isReferrer(_u: U): boolean {
    return true;
  }

  protected rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  protected allUnits(): U[] {
    return [...this.files.values()].flatMap((f) => f.units as U[]);
  }

  protected unitAt(root: RootRef): U | undefined {
    const units = (this.files.get(root.file)?.units ?? []) as U[];
    return units.find((u) => u.name === root.symbol) ?? units.find((u) => !u.name.includes(".") && u.names.includes(root.symbol));
  }

  /** Who refers to each unit. */
  protected referrers(): Map<U, Set<U>> {
    if (this.reverse) return this.reverse;
    const rev = new Map<U, Set<U>>();
    for (const u of this.allUnits()) {
      if (!this.isReferrer(u)) continue;
      for (const r of this.refsOf(u)) {
        const set = rev.get(r) ?? new Set();
        set.add(u);
        rev.set(r, set);
      }
    }
    this.reverse = rev;
    return rev;
  }

  usedBy(root: RootRef): string[] {
    const u = this.unitAt(root);
    if (!u) return [];
    const members = new Set(this.members(u));
    const files = new Set<string>();
    for (const m of members) for (const r of this.referrers().get(m) ?? []) if (!members.has(r)) files.add(r.file.rel);
    return [...files].sort();
  }

  rootShape(root: RootRef): { shape: string; rootText: string } | undefined {
    const u = this.unitAt(root);
    return u && this.shapeOf(u);
  }

  protected shapeOf(u: U): { shape: string; rootText: string } {
    const toks = tokens(u.node, u.file.text);
    const own = u.names[0]!;
    return { shape: hash(toks.map((t) => (t === own ? "$" : t)).join(" ")), rootText: toks.join(" ") };
  }

  slice(root: RootRef, opts: SliceOptions): Slice | undefined {
    const u = this.unitAt(root);
    if (!u) return undefined;
    return {
      root: { file: u.file.rel, symbol: u.name, line: u.line, default: false },
      ...this.trace([u], opts),
      ...this.shapeOf(u),
    };
  }

  /**
   * The code a set of roots is made of: the roots (a type with its members), plus every declaration they reach
   * that nothing else refers to. Declarations other code also uses are linked as shared, by file#name, and
   * registered components are linked as uses.
   */
  trace(roots: (U | RootRef)[], opts: SliceOptions): Pick<Slice, "chunks" | "uses" | "shared"> {
    const units = roots.map((r) => ("node" in r ? r : this.unitAt(r))).filter((x): x is U => !!x);
    const rootOwners = new Set(units.map((u) => this.ownerOf(u)).filter(Boolean));

    // Other registered components. A registered type owns its members, unless the root is one of them.
    const boundary = new Map<U, RootRef>();
    const bounds = opts.boundaries.map((b) => ({ b, u: this.unitAt(b) })).filter((x): x is { b: RootRef; u: U } => !!x.u && !units.includes(x.u));
    for (const { b, u } of bounds) boundary.set(u, b);
    for (const { b, u } of bounds) {
      const owner = this.ownerOf(u);
      if (!owner || rootOwners.has(owner)) continue;
      for (const m of this.members(u)) if (!boundary.has(m) && !units.includes(m)) boundary.set(m, b);
    }
    const uses: RootRef[] = [];
    const addUse = (b: RootRef) => {
      if (!uses.some((x) => x.file === b.file && x.symbol === b.symbol)) uses.push({ file: b.file, symbol: b.symbol });
    };

    const included = new Set<U>();
    for (const u of units) {
      for (const m of this.members(u)) {
        const b = m === u ? undefined : boundary.get(m);
        if (b) addUse(b);
        else included.add(m);
      }
    }
    for (const c of this.companions(included)) included.add(c);

    const reached = new Set<U>();
    const stack = [...included];
    while (stack.length) {
      for (const r of this.refsOf(stack.pop()!)) {
        if (included.has(r) || reached.has(r)) continue;
        const b = boundary.get(r);
        if (b) addUse(b);
        else {
          reached.add(r);
          stack.push(r);
        }
      }
    }

    // Keep only what nothing else refers to: the largest set whose referrers are all inside.
    const owned = new Set(reached);
    const rev = this.referrers();
    for (let changed = true; changed; ) {
      changed = false;
      for (const u of owned) {
        if ([...(rev.get(u) ?? [])].some((r) => !owned.has(r) && !included.has(r))) {
          owned.delete(u);
          changed = true;
        }
      }
    }
    const all = new Set([...included, ...owned]);
    const shared = new Set<string>();
    for (const u of all) for (const r of this.refsOf(u)) if (!all.has(r) && !boundary.has(r)) shared.add(`${r.file.rel}#${r.name}`);

    const byFile = new Map<UnitFile, Set<U>>();
    for (const u of all) byFile.set(u.file, (byFile.get(u.file) ?? new Set()).add(u));
    const first = units[0]?.file;
    const files = [...byFile.keys()].sort((a, b) => (a === first ? -1 : b === first ? 1 : a.rel.localeCompare(b.rel)));
    const chunks = files.map((f) => this.chunk(f, byFile.get(f)!));
    const taken = new Set(chunks.map((c) => c.file));
    for (const pin of opts.pins) {
      if (taken.has(pin)) continue;
      const c = this.fileChunk(pin);
      if (c) chunks.push(c);
    }
    return { chunks, uses, shared: [...shared].sort() };
  }

  private chunk(file: UnitFile, units: Set<U>): Chunk {
    if (units.size === file.units.length) {
      return { file: file.rel, kind: "code", text: file.text, hash: hash(tokens(file.tree, file.text).join(" ")) };
    }
    const needsImports = [...units].some((u) => this.usesImports(u));
    const kept = new Set(file.items.filter((i) => (i.unit ? units.has(i.unit as U) : !i.import || needsImports)));
    // Consecutive kept items form one range, blank lines between them included; anything left out splits it.
    const ranges: [number, number][] = [];
    let open = false;
    for (const item of file.items) {
      if (!kept.has(item)) {
        open = false;
        continue;
      }
      const last = ranges[ranges.length - 1];
      if (open && last) last[1] = Math.max(last[1], item.to);
      else ranges.push([item.from, item.to]);
      open = true;
    }
    const lines = file.text.split("\n");
    const text = ranges.map(([a, b]) => lines.slice(a - 1, b).join("\n")).join("\n// …\n");
    const toks = [...units].sort((a, b) => a.from - b.from).flatMap((u) => tokens(u.node, file.text));
    return { file: file.rel, kind: "code", ranges, text, hash: hash(toks.join(" ")) };
  }

  private fileChunk(rel: string): Chunk | undefined {
    const own = this.files.get(rel);
    if (own) return { file: rel, kind: "code", text: own.text, hash: hash(tokens(own.tree, own.text).join(" ")) };
    const abs = resolve(this.root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    const text = readFileSync(abs, "utf8");
    return { file: rel, kind: extname(abs) === ".css" ? "style" : "asset", text, hash: hash(normalizeStyle(text)) };
  }
}

/** The row a declaration's doc comment starts on: the comments directly above it, with no blank line between. */
export function docStart(siblings: Syntax[], at: number): number {
  let row = siblings[at]?.row ?? 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = siblings[i]!;
    if ((c.type !== "comment" && c.type !== "multiline_comment") || c.endRow < row - 1) break;
    row = c.row;
  }
  return row;
}

export function findDeep(n: Syntax, test: (n: Syntax) => boolean): Syntax | undefined {
  for (const c of n.children) {
    if (test(c)) return c;
    const hit = findDeep(c, test);
    if (hit) return hit;
  }
  return undefined;
}
