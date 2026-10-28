#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { Library, type Resolved } from "./engine.ts";
import { openWorkspace } from "./open.ts";
import { search, words } from "./search.ts";
import { findRoot, Store } from "./store.ts";
import type { Candidate, Chunk, Entry, Example, RootRef, Workspace } from "./types.ts";

const HELP = `myc: live, named handles on the components of a codebase

usage: myc [-C <dir>] <command> [options] [--json]

  list                          the catalog: one line per registered component
  search <words>                find registered components by name, note, tag or path
  show <slug>... [--no-code]    a component's code from every file it spans, root first
  scan [--all]                  components in the code that aren't registered yet
  add [<slug>] <file[#Symbol]>  register a component by its root declaration
      [--name <text>] [--note <text>] [--tags a,b] [--alias <name>] [--pin <file>]
      [--example '<name>={"prop":1}']
  add --all [--tags a,b]        register everything scan lists, with its suggested slugs
  edit <slug>                   change an entry: --name --note --tags --alias --unalias
                                --root <file[#Symbol]> --pin <file> --unpin <file>
                                --example '<name>={json props}' --unexample <name>
  check [--update]              re-find every component after edits; --update records them
  remove <slug>                 unregister a component (the code is untouched)
  play [--port 4777]            render every component live from the code, with its examples
  mcp                           serve these commands as MCP tools over stdio

  -C <dir>   run as if started in <dir>
  --json     machine-readable output
  --version  print the version

Only the root is stored. The files a component owns, the ones it shares and the
components it renders are traced from the code on every lookup.`;

const BOOLEAN = new Set(["json", "all", "update", "no-code", "help", "version"]);
const GLOBAL = ["json", "C", "help", "version"];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

class Fail extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

class Flags {
  constructor(private readonly map: Map<string, string[]>) {}
  names(): string[] {
    return [...this.map.keys()];
  }
  has(name: string): boolean {
    return this.map.has(name);
  }
  one(name: string): string | undefined {
    return this.map.get(name)?.at(-1);
  }
  /** Every value given; with `split`, comma lists too: `--tags a,b --tags c` is a, b, c. Names and paths may hold commas. */
  list(name: string, split = false): string[] {
    return (this.map.get(name) ?? []).flatMap((v) => (split ? v.split(",") : [v])).map((v) => v.trim()).filter(Boolean);
  }
}

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const map = new Map<string, string[]>();
  const set = (name: string, value: string) => map.set(name, [...(map.get(name) ?? []), value]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") set("help", "true");
    else if (a === "-C") {
      const v = argv[++i];
      if (v === undefined) throw new Fail("-C needs a directory", 2);
      set("C", v);
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = a.slice(2, eq < 0 ? undefined : eq);
      if (BOOLEAN.has(name)) set(name, "true");
      else if (eq >= 0) set(name, a.slice(eq + 1));
      else {
        const v = argv[++i];
        if (v === undefined) throw new Fail(`--${name} needs a value`, 2);
        set(name, v);
      }
    } else pos.push(a);
  }
  return { pos, flags: new Flags(map) };
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Takes a command's result in both forms instead of out, for callers that pick one later (the MCP server). */
  result?: (data: unknown, text: string) => void;
  /** The code analysis of a project, for a long-running caller that keeps it between commands (see Workspaces). */
  workspace?: (root: string) => Workspace;
}

class Ctx {
  readonly root: string;
  readonly store: Store;
  private library?: Library;

  constructor(
    readonly cwd: string,
    readonly json: boolean,
    readonly io: Io,
  ) {
    this.root = findRoot(cwd);
    this.store = new Store(this.root);
  }

  /** The code analysis, loaded only by commands that need it: list and search read the store alone. */
  get lib(): Library {
    return (this.library ??= new Library(this.io.workspace?.(this.root) ?? openWorkspace(this.root), this.store));
  }

  /** A path from the workspace root. Relative paths are taken from the cwd, then from the root. */
  path(p: string): string {
    let abs = resolve(this.cwd, p);
    if (!existsSync(abs) && !isAbsolute(p) && existsSync(resolve(this.root, p))) abs = resolve(this.root, p);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Fail(`${p} is outside the project at ${this.root}`, 2);
    if (!existsSync(abs)) throw new Fail(`${p} doesn't exist`, 2);
    return rel.split(sep).join("/");
  }

  print(data: unknown, text: string | string[]): void {
    const t = Array.isArray(text) ? text.join("\n") : text;
    if (this.io.result) this.io.result(data, t);
    else this.io.out(this.json ? JSON.stringify(data, null, 2) : t);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

const ref = (r: RootRef) => `${r.file}#${r.symbol}`;

function humanize(slug: string): string {
  const s = words(slug).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One catalog line. The name only shows when it says something the slug doesn't. */
function catalogLine(e: Entry): string {
  const named = e.name && e.name.toLowerCase() !== humanize(e.slug).toLowerCase();
  const head = named ? `${e.slug} (${e.name})` : e.slug;
  return e.note ? `${head} — ${e.note}` : named ? head : `${head} — ${ref(e.root)}`;
}

/** A slug for a candidate: its name for components, its route for Next.js pages and layouts. */
function suggest(c: Candidate, taken: Set<string>): string {
  let base: string;
  if (c.file.endsWith(".go")) {
    // A view method is named for itself, not its receiver; a model called just "model" by its package.
    const name = c.symbol.slice(c.symbol.lastIndexOf(".") + 1);
    base = words(name).join("-");
    if (base === "model") base = [...words(c.file.split("/").at(-2) ?? ""), "model"].join("-");
  } else if (c.kind === "component" || !/\.[cm]?[jt]sx?$/.test(c.file)) {
    base = words(c.symbol === "default" ? basename(c.file, extname(c.file)) : c.symbol).join("-");
  } else {
    const parts = c.file.split("/");
    const at = Math.max(parts.lastIndexOf("app"), parts.lastIndexOf("pages"));
    const route = parts
      .slice(at + 1, -1)
      .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"))
      .flatMap(words);
    const name = basename(c.file, extname(c.file));
    if (parts[at] === "pages" && name !== "index" && !name.startsWith("_")) route.push(...words(name));
    if (route.length === 0) route.push(c.kind === "layout" ? "root" : "home");
    base = [...route, c.kind === "layout" ? "layout" : "page"].join("-");
  }
  base ||= "component";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

/** `--example 'name={"title":"Hi"}'`: a named set of props; a bare name renders with none. */
function example(spec: string): Example {
  const eq = spec.indexOf("=");
  const name = (eq < 0 ? spec : spec.slice(0, eq)).trim();
  if (!name) throw new Fail(`an example needs a name: --example 'empty={"items":[]}'`, 2);
  if (eq < 0) return { name, props: {} };
  let props: unknown;
  try {
    props = JSON.parse(spec.slice(eq + 1));
  } catch {
    throw new Fail(`${name}'s props aren't valid JSON: ${spec.slice(eq + 1)}`, 2);
  }
  if (!props || typeof props !== "object" || Array.isArray(props)) throw new Fail(`${name}'s props must be a JSON object`, 2);
  return { name, props: props as Record<string, unknown> };
}

/** Examples with later ones replacing earlier ones of the same name. */
function mergeExamples(base: Example[], add: Example[], drop: Set<string> = new Set()): Example[] {
  const byName = new Map(base.map((e) => [e.name, e]));
  for (const e of add) byName.set(e.name, e);
  return [...byName.values()].filter((e) => !drop.has(e.name));
}

function ranges(c: Chunk): string {
  return c.ranges ? `:${c.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",")}` : "";
}

function field(label: string, values: string[]): string[] {
  return values.map((v, i) => `${i === 0 ? label.padEnd(9) : " ".repeat(9)}${v}`);
}

/** Levenshtein distance, for catching typos in slugs. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

function notFound(ctx: Ctx, slug: string): never {
  const entries = ctx.store.all();
  const typos = entries
    .map((e) => ({ slug: e.slug, d: distance(slug, e.slug) }))
    .filter((t) => t.d <= Math.max(2, Math.floor(slug.length / 3)))
    .sort((a, b) => a.d - b.d)
    .map((t) => t.slug);
  const near = [...new Set([...typos, ...search(entries, slug).map((h) => h.entry.slug)])].slice(0, 3);
  throw new Fail(`no component named ${slug}${near.length ? `; did you mean ${near.join(", ")}?` : ""}`);
}

/** Turns `file[#Symbol]` into a root, picking the file's only or default component when no symbol is given. */
function pickRoot(ctx: Ctx, spec: string): RootRef {
  const at = spec.lastIndexOf("#");
  const file = ctx.path(at < 0 ? spec : spec.slice(0, at));
  const symbol = at < 0 ? "" : spec.slice(at + 1);
  const here = ctx.lib.allCandidates().filter((c) => c.file === file);
  const options = here.map((c) => `  ${ref(c)}${c.default ? "  (default export)" : ""}`).join("\n");
  if (symbol) {
    const hit = here.find((c) => c.symbol === symbol) ?? (symbol === "default" ? here.find((c) => c.default) : undefined);
    if (hit) return { file, symbol: hit.symbol };
    // Not a component, but any top-level declaration can be a root.
    if (ctx.lib.ws.rootShape({ file, symbol })) return { file, symbol };
    throw new Fail(`${file} has no top-level declaration named ${symbol}${here.length ? `; its components:\n${options}` : ""}`, 2);
  }
  const pick = here.length === 1 ? here : here.filter((c) => c.default);
  if (pick.length === 1) return { file, symbol: pick[0]!.symbol };
  if (here.length === 0) throw new Fail(`found no components in ${file}; name the declaration: ${file}#Name`, 2);
  throw new Fail(`${file} has ${here.length} components; pick one:\n${options}`, 2);
}

function claimed(ctx: Ctx, root: RootRef, slug: string): void {
  const owner = ctx.lib.slugAt(root);
  if (owner && owner !== slug) throw new Fail(`${ref(root)} is already registered as ${owner}`);
}

function describe(r: Resolved, code: boolean): string[] {
  const e = r.entry;
  const lines = [`${e.slug} — ${e.name}  [${r.status}]`];
  if (e.note) lines.push(e.note);
  lines.push("");
  lines.push(...field("root", [`${ref(r.root)}${r.slice ? `:${r.slice.root.line}` : ""}`]));
  if (r.relink) {
    const score = r.relink.score !== undefined ? ` ${r.relink.score}` : "";
    lines.push(...field("was", [`${ref(r.relink.from)} (${r.relink.how}${score})`]));
  }
  if (r.status === "orphaned") {
    lines.push(...field("", [`the root is gone and nothing matches it: myc edit ${e.slug} --root <file#Symbol>`]));
  }
  if (r.slice) {
    lines.push(...field("files", r.slice.chunks.map((c) => `${c.file}${ranges(c)}`)));
    lines.push(...field("uses", r.uses));
    lines.push(...field("shared", r.slice.shared));
  }
  lines.push(...field("used by", r.usedBy.map((u) => (u.slug ? `${u.file} (${u.slug})` : u.file))));
  if (r.drift) {
    lines.push(...field("changed", r.drift.changed));
    lines.push(...field("added", r.drift.added));
    lines.push(...field("removed", r.drift.removed));
  }
  if (e.pins.length) lines.push(...field("pinned", e.pins));
  if (e.tags.length) lines.push(...field("tags", [e.tags.join(", ")]));
  if (e.aliases.length) lines.push(...field("aliases", [e.aliases.join(", ")]));
  if (e.examples?.length) lines.push(...field("examples", e.examples.map((x) => `${x.name} ${JSON.stringify(x.props)}`)));
  if (code && r.slice) {
    for (const c of r.slice.chunks) {
      lines.push("", `── ${c.file}${ranges(c)}`, c.text?.replace(/\n+$/, "") ?? `(binary ${c.kind}, not shown)`);
    }
  }
  return lines;
}

function toJson(r: Resolved, code: boolean) {
  const { fingerprint: _, ...entry } = r.entry;
  return {
    ...entry,
    status: r.status,
    root: { ...r.root, line: r.slice?.root.line },
    relink: r.relink,
    files: r.slice?.chunks.map((c) => ({
      file: c.file,
      kind: c.kind,
      ranges: c.ranges,
      hash: c.hash,
      ...(code ? { text: c.text } : {}),
    })),
    uses: r.uses,
    shared: r.slice?.shared ?? [],
    usedBy: r.usedBy,
    drift: r.drift,
  };
}

/** Registers every component scan lists, so any project has a library in one call; notes can come later. */
function addAll(ctx: Ctx, pos: string[], flags: Flags): void {
  const per = ["root", "name", "note", "alias", "pin", "example"].filter((f) => flags.has(f));
  if (pos.length || per.length) throw new Fail(`add --all registers everything scan lists, so it takes no ${pos.length ? "root" : `--${per[0]}`}`, 2);
  const taken = new Set(ctx.store.all().map((e) => e.slug));
  const now = new Date().toISOString();
  const added: Resolved[] = [];
  for (const c of ctx.lib.unregistered()) {
    const slug = suggest(c, taken);
    const entry: Entry = {
      slug,
      name: humanize(slug),
      aliases: [],
      note: "",
      tags: flags.list("tags", true),
      root: { file: c.file, symbol: c.symbol },
      pins: [],
      createdAt: now,
      updatedAt: now,
    };
    const r = ctx.lib.register(entry);
    if (r) added.push(r);
  }
  ctx.print(
    added.map((r) => toJson(r, false)),
    added.length
      ? [...added.map((r) => `added ${catalogLine(r.entry)}`), "", `${added.length} added. Give each a note: myc edit <slug> --note "<what it is>"`]
      : "every exported component is already registered",
  );
}

// ── commands ─────────────────────────────────────────────────────────

type Run = (ctx: Ctx, pos: string[], flags: Flags) => number | void;

const COMMANDS: Record<string, { flags: string[]; run: Run }> = {
  list: {
    flags: [],
    run(ctx) {
      const entries = ctx.store.all();
      ctx.print(
        entries.map(({ fingerprint: _, ...e }) => e),
        entries.length ? entries.map(catalogLine) : "the library is empty; myc scan lists what can be registered",
      );
    },
  },

  search: {
    flags: [],
    run(ctx, pos) {
      const query = pos.join(" ");
      if (!query.trim()) throw new Fail("usage: myc search <words>", 2);
      const hits = search(ctx.store.all(), query);
      ctx.print(
        hits.map((h) => ({ slug: h.entry.slug, name: h.entry.name, note: h.entry.note, root: h.entry.root, score: h.score })),
        hits.length ? hits.map((h) => catalogLine(h.entry)) : `nothing matches "${query}"`,
      );
      return hits.length ? 0 : 1;
    },
  },

  show: {
    flags: ["no-code"],
    run(ctx, pos, flags) {
      if (pos.length === 0) throw new Fail("usage: myc show <slug>...", 2);
      const code = !flags.has("no-code");
      const all = pos.map((slug) => (ctx.store.get(slug) ? ctx.lib.resolve(slug)! : notFound(ctx, slug)));
      ctx.print(
        all.length === 1 ? toJson(all[0]!, code) : all.map((r) => toJson(r, code)),
        all.map((r) => describe(r, code).join("\n")).join("\n\n\n"),
      );
      return all.some((r) => r.status === "orphaned") ? 1 : 0;
    },
  },

  scan: {
    flags: ["all"],
    run(ctx, _pos, flags) {
      const all = flags.has("all");
      const taken = new Set(ctx.store.all().map((e) => e.slug));
      const rows = ctx.lib.unregistered(all).map((c) => ({ ...c, suggested: suggest(c, taken) }));
      const width = Math.max(0, ...rows.map((r) => ref(r).length));
      const text = rows.length
        ? [
            ...rows.map((r) => `${ref(r).padEnd(width)}  ${`${r.kind}${r.exported ? "" : ", internal"}`.padEnd(20)}→ ${r.suggested}`),
            "",
            `${rows.length} unregistered. Register one with: myc add <slug> <file#Symbol> --note "<what it is>"`,
          ]
        : [all ? "every component is registered" : "every exported component is registered (--all includes internal ones)"];
      ctx.print(rows, text);
    },
  },

  add: {
    flags: ["root", "name", "note", "tags", "alias", "pin", "example", "all"],
    run(ctx, pos, flags) {
      if (flags.has("all")) return addAll(ctx, pos, flags);
      let slug = pos.find((p) => SLUG.test(p));
      const spec = flags.one("root") ?? pos.find((p) => p !== slug);
      if (!spec || pos.length > 2) throw new Fail("usage: myc add [<slug>] <file[#Symbol]> [--note <text>]", 2);
      const root = pickRoot(ctx, spec);
      const existing = ctx.store.all();
      if (!slug) {
        const c = ctx.lib.allCandidates().find((c) => c.file === root.file && c.symbol === root.symbol);
        slug = c ? suggest(c, new Set(existing.map((e) => e.slug))) : words(root.symbol).join("-");
      }
      if (!SLUG.test(slug)) throw new Fail(`slugs are lowercase words joined by dashes, like settings-dialog: ${slug}`, 2);
      if (ctx.store.get(slug)) throw new Fail(`${slug} is already registered; change it with myc edit ${slug}`);
      claimed(ctx, root, slug);
      const now = new Date().toISOString();
      const entry: Entry = {
        slug,
        name: flags.one("name") ?? humanize(slug),
        aliases: flags.list("alias"),
        note: flags.one("note") ?? "",
        tags: flags.list("tags", true),
        root,
        pins: flags.list("pin").map((p) => ctx.path(p)),
        ...(flags.has("example") ? { examples: mergeExamples([], flags.list("example").map(example)) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const r = ctx.lib.register(entry);
      if (!r) throw new Fail(`couldn't trace ${ref(root)}`);
      ctx.print(toJson(r, false), ["added", ...describe(r, false)]);
    },
  },

  edit: {
    flags: ["root", "name", "note", "tags", "alias", "unalias", "pin", "unpin", "example", "unexample"],
    run(ctx, pos, flags) {
      const slug = pos[0];
      if (!slug || pos.length > 1) {
        throw new Fail("usage: myc edit <slug> [--name --note --tags --alias --unalias --root --pin --unpin --example --unexample]", 2);
      }
      const before = ctx.store.get(slug) ?? notFound(ctx, slug);
      if (flags.names().every((n) => GLOBAL.includes(n))) throw new Fail("nothing to change; see myc help", 2);
      const e: Entry = { ...before, updatedAt: new Date().toISOString() };
      const name = flags.one("name");
      const note = flags.one("note");
      if (name !== undefined) e.name = name;
      if (note !== undefined) e.note = note;
      if (flags.has("tags")) e.tags = flags.list("tags", true);
      const unalias = new Set(flags.list("unalias"));
      e.aliases = [...new Set([...e.aliases, ...flags.list("alias")])].filter((a) => !unalias.has(a));
      const unpin = new Set(flags.list("unpin").map((p) => ctx.path(p)));
      e.pins = [...new Set([...e.pins, ...flags.list("pin").map((p) => ctx.path(p))])].filter((p) => !unpin.has(p));
      if (flags.has("example") || flags.has("unexample")) {
        e.examples = mergeExamples(e.examples ?? [], flags.list("example").map(example), new Set(flags.list("unexample")));
      }
      const spec = flags.one("root");
      if (spec) {
        e.root = pickRoot(ctx, spec);
        claimed(ctx, e.root, slug);
      }
      // A new root or new pins change what the component is, so its fingerprint starts over.
      if (spec || e.pins.join() !== before.pins.join()) {
        const r = ctx.lib.register(e);
        if (!r) throw new Fail(`couldn't trace ${ref(e.root)}`);
        ctx.print(toJson(r, false), ["updated", ...describe(r, false)]);
      } else {
        ctx.store.put(e);
        ctx.print({ ...e, fingerprint: undefined }, `updated ${catalogLine(e)}`);
      }
    },
  },

  check: {
    flags: ["update"],
    run(ctx, _pos, flags) {
      const update = flags.has("update");
      const all = ctx.lib.resolveAll();
      const rows = all.map((r) => {
        let detail = "";
        if (r.relink) detail = `${ref(r.relink.from)} → ${ref(r.root)} (${r.relink.how}${r.relink.score !== undefined ? ` ${r.relink.score}` : ""})`;
        else if (r.status === "orphaned") detail = `${ref(r.root)} is gone`;
        else if (r.status === "new") detail = "no fingerprint yet";
        else if (r.drift) {
          const d = r.drift;
          detail = [
            d.changed.length ? `changed ${d.changed.join(", ")}` : "",
            d.added.length ? `added ${d.added.join(", ")}` : "",
            d.removed.length ? `removed ${d.removed.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ");
        }
        const recorded = update && r.status !== "ok" && r.status !== "orphaned" && !!r.slice;
        if (recorded) ctx.lib.record(r);
        return { slug: r.entry.slug, status: r.status, detail, recorded, relink: r.relink, drift: r.drift };
      });
      const unregistered = ctx.lib.unregistered().length;
      const width = Math.max(0, ...rows.map((r) => r.slug.length));
      const pending = rows.filter((r) => r.status !== "ok" && r.status !== "orphaned" && !r.recorded).length;
      const text = rows.map((r) => `${r.status.padEnd(9)} ${r.slug.padEnd(width)}  ${r.detail}${r.recorded ? "  (recorded)" : ""}`.trimEnd());
      if (rows.length === 0) text.push("the library is empty");
      if (pending) text.push("", `${pending} changed since last recorded; myc check --update records them`);
      if (unregistered) text.push("", `${unregistered} exported components aren't registered; myc scan lists them`);
      ctx.print({ components: rows, unregistered }, text);
      return rows.some((r) => r.status === "orphaned") ? 1 : 0;
    },
  },

  remove: {
    flags: [],
    run(ctx, pos) {
      if (pos.length === 0) throw new Fail("usage: myc remove <slug>...", 2);
      for (const slug of pos) if (!ctx.store.get(slug)) notFound(ctx, slug);
      for (const slug of pos) ctx.store.remove(slug);
      ctx.print({ removed: pos }, pos.map((s) => `removed ${s}`));
    },
  },
};

export function run(argv: string[], io: Io = { out: (t) => console.log(t), err: (t) => console.error(t) }): number {
  let json = argv.includes("--json");
  try {
    const { pos, flags } = parse(argv);
    json = flags.has("json");
    const [name, ...rest] = pos;
    if (name === "version" || (flags.has("version") && !name)) {
      io.out(pkg.version);
      return 0;
    }
    if (!name || name === "help" || flags.has("help")) {
      io.out(HELP);
      return 0;
    }
    const command = COMMANDS[name];
    if (!command) throw new Fail(`unknown command ${name}; see myc help`, 2);
    const bad = flags.names().find((n) => !GLOBAL.includes(n) && !command.flags.includes(n));
    if (bad) throw new Fail(`${name} doesn't take --${bad}; see myc help`, 2);
    const ctx = new Ctx(resolve(flags.one("C") ?? process.cwd()), json, io);
    return command.run(ctx, rest, flags) ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) io.out(JSON.stringify({ error: message }));
    else io.err(`myc: ${message}`);
    return err instanceof Fail ? err.code : 1;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // The MCP server and the playground run until stopped, so they live outside the one-shot commands.
  let serve: { name: string; root: string; port?: number } | undefined;
  try {
    const { pos, flags } = parse(argv);
    if ((pos[0] === "mcp" || pos[0] === "play") && !flags.has("help")) {
      const port = flags.one("port");
      if (port !== undefined && !/^\d+$/.test(port)) throw new Fail(`--port takes a number: ${port}`, 2);
      serve = { name: pos[0], root: findRoot(resolve(flags.one("C") ?? process.cwd())), port: port ? Number(port) : undefined };
    }
  } catch (err) {
    if (err instanceof Fail) {
      console.error(`myc: ${err.message}`);
      process.exit(err.code);
    }
    // run() reports the bad arguments.
  }
  if (serve?.name === "mcp") await (await import("./mcp.ts")).serve(serve.root);
  else if (serve?.name === "play") {
    const { play } = await import("./play.ts");
    const p = play(serve.root, { port: serve.port });
    const slugs = new Store(serve.root).all().map((e) => e.slug);
    console.log(`myc play: ${p.url}  (${slugs.length} components; Ctrl-C stops it)`);
    for (const slug of slugs) console.log(`  ${p.url}c/${slug}`);
    process.on("SIGINT", () => {
      p.stop();
      process.exit(0);
    });
  } else process.exitCode = run(argv);
}
