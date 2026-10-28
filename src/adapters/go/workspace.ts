import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Candidate, RootRef } from "../../types.ts";
import { child, parse, type Syntax } from "../grammars.ts";
import { docStart, findDeep, type Unit as BaseUnit, type UnitFile, UnitWorkspace } from "../units.ts";

/** Directories the go tool itself ignores, plus vendored and installed code. */
const SKIP_DIRS = new Set(["vendor", "testdata", "node_modules"]);
/** A package that imports one of these draws a terminal UI, so its views are components. */
const TUI = /^(github\.com\/charmbracelet|charm\.land)\/(bubbletea|lipgloss|bubbles)(\/v\d+)?(\/|$)/;
/** Calls that compose a view: styling, layout, or a sub-model's View. */
const RENDER_CALLS = new Set(["Render", "View", "JoinVertical", "JoinHorizontal", "Place", "PlaceHorizontal", "PlaceVertical"]);
/** Methods every type may have that aren't views of their own. */
const NOT_VIEWS = new Set(["String", "GoString", "Error", "View", "view"]);

type UnitKind = "type" | "func" | "method" | "var" | "const";

/** A top-level declaration: Go is sliced in these, since a package shares one scope across its files. Methods are Type.method. */
interface Unit extends BaseUnit {
  file: GoFile;
  kind: UnitKind;
  recv?: string;
}

interface GoFile extends UnitFile {
  pkg: Pkg;
  /** Local name → import path. */
  imports: Map<string, string>;
  rawImports: { name?: string; path: string }[];
  units: Unit[];
}

interface Pkg {
  dir: string;
  name: string;
  files: GoFile[];
  /** Package-level types, funcs, vars and consts by name; build-tagged files may declare one twice. */
  scope: Map<string, Unit[]>;
  /** Type → method → declarations. */
  methods: Map<string, Map<string, Unit[]>>;
  /** Struct type → field → the field's type, read in its file. */
  fields: Map<string, Map<string, { type: Syntax; file: GoFile }>>;
  embeds: Map<string, string[]>;
  tui: boolean;
}

interface TypeRef {
  pkg: Pkg;
  name: string;
}

/** A type that is known not to be one of this workspace's: a builtin, another module's, or a literal type. */
const FOREIGN = "foreign";
/** A local type, FOREIGN, or undefined when it can't be told. */
type Typed = TypeRef | typeof FOREIGN | undefined;

export function isGoWorkspace(root: string): boolean {
  return existsSync(join(root, "go.mod")) || existsSync(join(root, "go.work"));
}

export class GoWorkspace extends UnitWorkspace<Unit, GoFile> {
  private pkgs = new Map<string, Pkg>();
  private modules: { dir: string; path: string }[] = [];
  private refCache = new Map<Unit, Set<Unit>>();
  private importUse = new Map<Unit, boolean>();

  constructor(root: string) {
    super(root);
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith(".") || d.name.startsWith("_") || SKIP_DIRS.has(d.name)) continue;
        const path = join(dir, d.name);
        if (d.isDirectory()) walk(path);
        else if (d.name === "go.mod") {
          const m = readFileSync(path, "utf8").match(/^\s*module\s+(\S+)/m);
          if (m) this.modules.push({ dir, path: m[1]!.replace(/^"|"$/g, "") });
        } else if (d.name.endsWith(".go") && !d.name.endsWith("_test.go")) sources.push(path);
      }
    };
    walk(root);
    for (const abs of sources) this.load(abs);
    for (const file of this.files.values()) {
      for (const imp of file.rawImports) {
        if (imp.name === "_" || imp.name === ".") continue;
        const name = imp.name ?? this.pkgAt(imp.path)?.name ?? defaultName(imp.path);
        file.imports.set(name, imp.path);
      }
      if (file.rawImports.some((i) => TUI.test(i.path))) file.pkg.tui = true;
    }
  }

  // ── loading ──────────────────────────────────────────────────────────

  private load(abs: string): void {
    const text = readFileSync(abs, "utf8");
    const tree = parse("go", text);
    const dir = dirname(abs);
    const clause = tree.children.find((n) => n.type === "package_clause");
    const ident = clause?.children.find((n) => n.type === "package_identifier");
    let pkg = this.pkgs.get(dir);
    if (!pkg) {
      pkg = { dir, name: ident ? text.slice(ident.start, ident.end) : "", files: [], scope: new Map(), methods: new Map(), fields: new Map(), embeds: new Map(), tui: false };
      this.pkgs.set(dir, pkg);
    }
    const file: GoFile = { abs, rel: this.rel(abs), text, tree, pkg, imports: new Map(), rawImports: [], items: [], units: [] };
    pkg.files.push(file);
    this.files.set(file.rel, file);

    const txt = (n: Syntax) => text.slice(n.start, n.end);
    const addUnit = (kind: UnitKind, names: string[], node: Syntax, siblings: Syntax[], at: number, recv?: string) => {
      const name = recv ? `${recv}.${names[0]}` : names[0]!;
      const unit: Unit = { file, kind, name, names, recv, node, from: docStart(siblings, at) + 1, to: node.endRow + 1, line: node.row + 1 };
      file.units.push(unit);
      file.items.push({ from: unit.from, to: unit.to, unit });
      if (recv) {
        const methods = pkg.methods.get(recv) ?? new Map<string, Unit[]>();
        methods.set(names[0]!, [...(methods.get(names[0]!) ?? []), unit]);
        pkg.methods.set(recv, methods);
      } else for (const n of names) pkg.scope.set(n, [...(pkg.scope.get(n) ?? []), unit]);
      return unit;
    };
    /** A declaration with one spec is kept whole, keyword and all; a grouped one is split into its specs. */
    const specs = (decl: Syntax, types: string[]): { node: Syntax; siblings: Syntax[]; at: number }[] => {
      const found: { spec: Syntax; parent: Syntax }[] = [];
      const find = (n: Syntax) => {
        for (const c of n.children) {
          if (types.includes(c.type)) found.push({ spec: c, parent: n });
          else if (c.type.endsWith("_list")) find(c);
        }
      };
      find(decl);
      if (found.length === 1) return [{ node: decl, siblings: [], at: -1 }];
      return found.map(({ spec, parent }) => ({ node: spec, siblings: parent.children, at: parent.children.indexOf(spec) }));
    };

    tree.children.forEach((n, i) => {
      const top = { siblings: tree.children, at: i };
      if (n.type === "package_clause") file.items.push({ from: n.row + 1, to: n.endRow + 1 });
      else if (n.type === "import_declaration") {
        file.items.push({ from: n.row + 1, to: n.endRow + 1, import: true });
        const visit = (s: Syntax) => {
          if (s.type === "import_spec") {
            const path = child(s, "path");
            const name = child(s, "name");
            if (path) file.rawImports.push({ path: txt(path).slice(1, -1), name: name && txt(name) });
          } else s.children.forEach(visit);
        };
        visit(n);
      } else if (n.type === "function_declaration") {
        const name = child(n, "name");
        if (name) addUnit("func", [txt(name)], n, top.siblings, top.at);
      } else if (n.type === "method_declaration") {
        const name = child(n, "name");
        const recv = receiverType(child(n, "receiver"), text);
        if (name && recv) addUnit("method", [txt(name)], n, top.siblings, top.at, recv);
      } else if (n.type === "type_declaration") {
        for (const s of specs(n, ["type_spec", "type_alias"])) {
          const spec = s.node === n ? n.children.find((c) => c.type === "type_spec" || c.type === "type_alias")! : s.node;
          const name = child(spec, "name");
          if (!name) continue;
          const unit = addUnit("type", [txt(name)], s.node, s.at < 0 ? top.siblings : s.siblings, s.at < 0 ? top.at : s.at);
          this.readFields(pkg, unit.name, child(spec, "type"), file);
        }
      } else if (n.type === "var_declaration" || n.type === "const_declaration") {
        const kind = n.type === "var_declaration" ? "var" : "const";
        for (const s of specs(n, ["var_spec", "const_spec"])) {
          const spec = s.node === n ? findDeep(n, (c) => c.type === "var_spec" || c.type === "const_spec")! : s.node;
          const names = spec.children.filter((c) => c.field === "name").map(txt);
          if (names.length && names.some((x) => x !== "_")) {
            addUnit(kind, names, s.node, s.at < 0 ? top.siblings : s.siblings, s.at < 0 ? top.at : s.at);
          }
        }
      }
    });
    file.items.sort((a, b) => a.from - b.from);
  }

  private readFields(pkg: Pkg, type: string, node: Syntax | undefined, file: GoFile): void {
    if (node?.type !== "struct_type") return;
    const fields = new Map<string, { type: Syntax; file: GoFile }>();
    const embeds: string[] = [];
    const list = node.children.find((c) => c.type === "field_declaration_list");
    for (const f of list?.children ?? []) {
      if (f.type !== "field_declaration") continue;
      const t = child(f, "type");
      if (!t) continue;
      const names = f.children.filter((c) => c.field === "name");
      if (names.length === 0) {
        const id = findDeep(t, (c) => c.type === "type_identifier");
        if (id) {
          const name = file.text.slice(id.start, id.end);
          fields.set(name, { type: t, file });
          embeds.push(name);
        }
      }
      for (const n of names) fields.set(file.text.slice(n.start, n.end), { type: t, file });
    }
    pkg.fields.set(type, fields);
    pkg.embeds.set(type, embeds);
  }

  /** The local package an import path names, if the code is in this workspace. */
  private pkgAt(path: string): Pkg | undefined {
    for (const m of this.modules) {
      if (path !== m.path && !path.startsWith(`${m.path}/`)) continue;
      const pkg = this.pkgs.get(join(m.dir, path.slice(m.path.length)));
      if (pkg) return pkg;
    }
    return undefined;
  }

  // ── types, as far as a reader without a type checker can follow them ─

  /** The named local type a type expression is about: *T, []T, map[K]T and pkg.T all lead to T. */
  private typeRef(node: Syntax | undefined, file: GoFile): Typed {
    if (!node) return undefined;
    const txt = (n: Syntax) => file.text.slice(n.start, n.end);
    switch (node.type) {
      case "type_identifier":
        return file.pkg.scope.get(txt(node))?.some((u) => u.kind === "type") ? { pkg: file.pkg, name: txt(node) } : FOREIGN;
      case "qualified_type": {
        const alias = child(node, "package");
        const name = child(node, "name");
        const pkg = alias && this.pkgAt(file.imports.get(txt(alias)) ?? "");
        return pkg && name ? { pkg, name: txt(name) } : FOREIGN;
      }
      case "generic_type":
        return this.typeRef(child(node, "type"), file);
      case "map_type":
        return this.typeRef(child(node, "value"), file);
      case "pointer_type":
      case "slice_type":
      case "array_type":
      case "channel_type":
      case "parenthesized_type":
        return this.typeRef(child(node, "element") ?? node.children.find((c) => c.named), file);
      case "parameter_list": {
        const first = node.children.find((c) => c.type === "parameter_declaration");
        return first ? this.typeRef(child(first, "type"), file) : undefined;
      }
      case "struct_type":
      case "interface_type":
      case "function_type":
        return FOREIGN;
    }
    return undefined;
  }

  private member<T>(t: TypeRef, get: (t: TypeRef) => T | undefined, depth = 0): T | undefined {
    const own = get(t);
    if (own !== undefined || depth > 3) return own;
    for (const e of t.pkg.embeds.get(t.name) ?? []) {
      const field = t.pkg.fields.get(t.name)?.get(e);
      const et = field && this.typeRef(field.type, field.file);
      const hit = typeof et === "object" ? this.member(et, get, depth + 1) : undefined;
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  private methodsOf(t: TypeRef, name: string): Unit[] | undefined {
    return this.member(t, (x) => x.pkg.methods.get(x.name)?.get(name));
  }

  private fieldType(t: TypeRef, name: string): Typed {
    return this.member(t, (x) => {
      const f = x.pkg.fields.get(x.name)?.get(name);
      return f && this.typeRef(f.type, f.file);
    });
  }

  /** A method name only one type in the package has, for calls on values whose type can't be followed. */
  private uniqueMethod(pkg: Pkg, name: string): Unit[] | undefined {
    let hit: Unit[] | undefined;
    for (const methods of pkg.methods.values()) {
      const m = methods.get(name);
      if (!m) continue;
      if (hit) return undefined;
      hit = m;
    }
    return hit;
  }

  // ── references ───────────────────────────────────────────────────────

  /** The units a unit refers to: package-level names, other packages' names, and methods it calls. */
  protected refsOf(u: Unit): Set<Unit> {
    const cached = this.refCache.get(u);
    if (cached) return cached;
    const out = new Set<Unit>();
    const file = u.file;
    const pkg = file.pkg;
    const txt = (n: Syntax) => file.text.slice(n.start, n.end);
    const env = new Map<string, Typed>();
    let usesImport = false;
    const add = (units?: Unit[]) => {
      for (const x of units ?? []) if (x !== u) out.add(x);
    };
    const bind = (names: Syntax[], t: Typed) => {
      for (const n of names) env.set(txt(n), t);
    };

    if (u.kind === "func" || u.kind === "method") {
      for (const list of [child(u.node, "receiver"), child(u.node, "parameters")]) {
        for (const p of list?.children ?? []) {
          if (p.type === "parameter_declaration" || p.type === "variadic_parameter_declaration") {
            bind(p.children.filter((c) => c.field === "name"), this.typeRef(child(p, "type"), file));
          }
        }
      }
    }

    const alias = (n: Syntax) => n.type === "identifier" && !env.has(txt(n)) && !pkg.scope.has(txt(n)) && file.imports.has(txt(n));
    const resultOf = (f: Unit | undefined): Typed => f && this.typeRef(child(f.node, "result"), f.file);

    /** What an expression's type is, when a reader can tell: enough to know whose method a call reaches. */
    const typeOf = (e: Syntax | undefined): Typed => {
      if (!e) return undefined;
      switch (e.type) {
        case "identifier": {
          if (env.has(txt(e))) return env.get(txt(e));
          const v = pkg.scope.get(txt(e))?.find((x) => x.kind === "var");
          const spec = v && (findDeep(v.node, (c) => c.type === "var_spec") ?? v.node);
          return spec ? (this.typeRef(child(spec, "type"), file) ?? typeOf(firstValue(spec))) : undefined;
        }
        case "selector_expression": {
          const operand = child(e, "operand");
          const field = child(e, "field");
          if (!operand || !field) return undefined;
          if (alias(operand)) return this.pkgAt(file.imports.get(txt(operand))!) ? undefined : FOREIGN;
          const t = typeOf(operand);
          return typeof t === "object" ? this.fieldType(t, txt(field)) : t;
        }
        case "parenthesized_expression":
          return typeOf(e.children.find((c) => c.named));
        case "unary_expression":
        case "index_expression":
          return typeOf(child(e, "operand"));
        case "composite_literal":
        case "type_assertion_expression":
        case "type_conversion_expression":
          return this.typeRef(child(e, "type"), file);
        case "call_expression": {
          const fn = child(e, "function");
          if (fn?.type === "identifier") {
            const local = pkg.scope.get(txt(fn));
            if (!local) return env.has(txt(fn)) ? undefined : FOREIGN;
            const f = local.find((x) => x.kind === "func");
            return f ? resultOf(f) : local.some((x) => x.kind === "type") ? { pkg, name: txt(fn) } : undefined;
          }
          if (fn?.type === "selector_expression") {
            const operand = child(fn, "operand");
            const field = child(fn, "field");
            if (!operand || !field) return undefined;
            if (alias(operand)) {
              const target = this.pkgAt(file.imports.get(txt(operand))!);
              return target ? resultOf(target.scope.get(txt(field))?.find((x) => x.kind === "func")) : FOREIGN;
            }
            const t = typeOf(operand);
            return typeof t === "object" ? resultOf(this.methodsOf(t, txt(field))?.[0]) : t;
          }
          return undefined;
        }
        case "interpreted_string_literal":
        case "raw_string_literal":
        case "int_literal":
        case "float_literal":
        case "rune_literal":
        case "true":
        case "false":
        case "nil":
        case "binary_expression":
        case "func_literal":
          return FOREIGN;
      }
      return undefined;
    };

    const walk = (n: Syntax, parent?: Syntax): void => {
      switch (n.type) {
        case "comment":
        case "field_identifier":
        case "package_identifier":
          return;
        case "parameter_list":
          if (n.field === "receiver") return;
          break;
        case "short_var_declaration": {
          const left = child(n, "left")?.children.filter((c) => c.type === "identifier") ?? [];
          const right = child(n, "right")?.children.filter((c) => c.named) ?? [];
          // a, err := f() takes the first result; the rest are the error or ok values.
          left.forEach((l, i) => env.set(txt(l), right.length === left.length ? typeOf(right[i]) : i === 0 ? typeOf(right[0]) : FOREIGN));
          break;
        }
        case "var_spec":
          if (n !== u.node) bind(n.children.filter((c) => c.field === "name"), this.typeRef(child(n, "type"), file) ?? typeOf(firstValue(n)));
          break;
        case "range_clause": {
          // for i, item := range items: the index is an int, the value is what the container holds.
          const ids = child(n, "left")?.children.filter((c) => c.type === "identifier") ?? [];
          ids.forEach((id, i) => env.set(txt(id), i === 0 ? FOREIGN : typeOf(child(n, "right"))));
          break;
        }
        case "identifier":
          if (!env.has(txt(n))) add(pkg.scope.get(txt(n)));
          return;
        case "type_identifier":
          add(pkg.scope.get(txt(n))?.filter((x) => x.kind === "type"));
          return;
        case "qualified_type": {
          const a = child(n, "package");
          const name = child(n, "name");
          usesImport = true;
          const target = a && this.pkgAt(file.imports.get(txt(a)) ?? "");
          if (target && name) add(target.scope.get(txt(name))?.filter((x) => x.kind === "type"));
          return;
        }
        case "selector_expression": {
          const operand = child(n, "operand");
          const field = child(n, "field");
          if (!operand || !field) break;
          const name = txt(field);
          if (alias(operand)) {
            usesImport = true;
            add(this.pkgAt(file.imports.get(txt(operand))!)?.scope.get(name));
            return;
          }
          // Only a type that can't be told at all falls back to the one local type with that method.
          const t = typeOf(operand);
          if (typeof t === "object") add(this.methodsOf(t, name));
          else if (t === undefined && parent?.type === "call_expression" && child(parent, "function") === n) add(this.uniqueMethod(pkg, name));
          walk(operand, n);
          return;
        }
      }
      for (const c of n.children) walk(c, n);
    };
    walk(u.node);
    this.refCache.set(u, out);
    this.importUse.set(u, usesImport);
    return out;
  }

  // ── discovery ────────────────────────────────────────────────────────

  /** Does the body build a view: style or lay out text, or render a sub-model? */
  private renders(u: Unit): boolean {
    if (/view$/i.test(u.names[0]!)) return true;
    const file = u.file;
    const txt = (n: Syntax) => file.text.slice(n.start, n.end);
    const body = child(u.node, "body");
    return !!(
      body &&
      findDeep(body, (n) => {
        if (n.type !== "call_expression") return false;
        const fn = child(n, "function");
        const field = fn?.type === "selector_expression" ? child(fn, "field") : undefined;
        return !!field && RENDER_CALLS.has(txt(field));
      })
    );
  }

  discover(): Candidate[] {
    const out: Candidate[] = [];
    for (const pkg of this.pkgs.values()) {
      if (!pkg.tui) continue;
      const views = new Set([...pkg.methods].filter(([, m]) => m.has("View") || m.has("view")).map(([t]) => t));
      for (const file of pkg.files) {
        for (const u of file.units) {
          let kind: Candidate["kind"] | undefined;
          if (u.kind === "type" && views.has(u.name)) {
            const m = pkg.methods.get(u.name)!;
            kind = m.has("Init") && m.has("Update") ? "screen" : "component";
          } else if ((u.kind === "func" || u.kind === "method") && returnsString(u) && !(u.recv && NOT_VIEWS.has(u.names[0]!)) && this.renders(u)) {
            kind = "component";
          }
          // Everything at package level is visible to the whole package, so none of it counts as internal.
          if (kind) out.push({ file: file.rel, symbol: u.name, kind, exported: true, default: false, line: u.line });
        }
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  // ── lookups ──────────────────────────────────────────────────────────

  protected ownerOf(u: Unit): string | undefined {
    const type = u.kind === "type" ? u.name : u.recv;
    return type && `${u.file.pkg.dir}:${type}`;
  }

  protected usesImports(u: Unit): boolean {
    this.refsOf(u);
    return this.importUse.get(u) ?? false;
  }

  /** A type comes with its methods, wherever in the package they're declared. */
  protected members(u: Unit): Unit[] {
    if (u.kind !== "type") return [u];
    const methods = [...(u.file.pkg.methods.get(u.name)?.values() ?? [])].flat();
    return [u, ...methods];
  }

  /** The method a Wails binding calls: wailsjs/go/<package>/<Struct>.<Method>. */
  bound(pkgName: string, type: string, method: string): RootRef | undefined {
    for (const pkg of this.pkgs.values()) {
      if (pkg.name !== pkgName) continue;
      const m = pkg.methods.get(type)?.get(method)?.[0];
      if (m) return { file: m.file.rel, symbol: m.name };
    }
    return undefined;
  }

}

// ── helpers ──────────────────────────────────────────────────────────

function firstValue(spec: Syntax): Syntax | undefined {
  return child(spec, "value")?.children.find((c) => c.named);
}

function receiverType(list: Syntax | undefined, text: string): string | undefined {
  const param = list?.children.find((c) => c.type === "parameter_declaration");
  const id = param && findDeep(param, (c) => c.type === "type_identifier");
  return id && text.slice(id.start, id.end);
}

function returnsString(u: Unit): boolean {
  const r = child(u.node, "result");
  return r?.type === "type_identifier" && u.file.text.slice(r.start, r.end) === "string";
}

/** The name an import is used by when it isn't renamed: the last path element, without a /vN suffix. */
function defaultName(path: string): string {
  const parts = path.split("/");
  let last = parts.pop() ?? path;
  if (/^v\d+$/.test(last) && parts.length) last = parts.pop()!;
  return last.replace(/^go-/, "").replace(/[-.]go$/, "").replace(/[^\w]/g, "_");
}
