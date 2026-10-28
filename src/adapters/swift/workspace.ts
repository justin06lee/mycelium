import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "../../types.ts";
import { child, parse, type Syntax } from "../grammars.ts";
import { docStart, findDeep, type Unit as BaseUnit, type UnitFile, UnitWorkspace } from "../units.ts";

/** Build output, dependencies and editor state that Swift tooling keeps next to the code. */
const SKIP_DIRS = new Set([".build", "build", "DerivedData", "Pods", "Carthage", "node_modules", ".swiftpm", "vendor"]);
/** Test targets: RuriTests, RuriUITests, Tests/<Target>Tests. */
const TEST_DIR = /Tests$/;
/** What a type conforms to that makes it a view. */
const VIEWS = new Set(["View", "ViewModifier"]);
const TYPE_KINDS = new Set(["struct", "class", "enum", "actor", "protocol"]);

type UnitKind = "type" | "extension" | "func" | "var" | "preview";

/** A top-level declaration: Swift is sliced in these, since a module's files share one scope without imports. */
interface Unit extends BaseUnit {
  file: SwiftFile;
  kind: UnitKind;
  /** The type an extension extends. */
  extends?: string;
  inherits: string[];
  /** private and fileprivate declarations are only visible in their file. */
  private: boolean;
}

interface SwiftFile extends UnitFile {
  module: Module;
  imports: string[];
  units: Unit[];
}

interface Module {
  name: string;
  /** Types, functions and globals by name. */
  scope: Map<string, Unit[]>;
  /** Local type → its extensions, which belong to it. */
  extensions: Map<string, Unit[]>;
  /** Members that extensions add to other modules' types (View.freshness()), by member name. */
  members: Map<string, Unit[]>;
  previews: Unit[];
}

/** A Swift package, or an Xcode project within two levels of the root. */
export function isSwiftWorkspace(root: string): boolean {
  if (existsSync(join(root, "Package.swift"))) return true;
  const dirs = [root, ...readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name)).map((d) => join(root, d.name))];
  return dirs.some((dir) => readdirSync(dir).some((n) => n.endsWith(".xcodeproj")));
}

export class SwiftWorkspace extends UnitWorkspace<Unit, SwiftFile> {
  private modules = new Map<string, Module>();
  private refCache = new Map<Unit, Set<Unit>>();
  private screens = new Set<Unit>();

  constructor(root: string) {
    super(root);
    // A file's module is its target: Sources/<Target>/… in a package, the folder beside the .xcodeproj in an app.
    const walk = (dir: string, module: string | undefined, xcode: boolean) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const here = xcode || entries.some((d) => d.name.endsWith(".xcodeproj"));
      for (const d of entries) {
        if (d.name.startsWith(".") || SKIP_DIRS.has(d.name) || d.name.endsWith(".xcodeproj")) continue;
        const path = join(dir, d.name);
        if (d.isDirectory()) {
          if (TEST_DIR.test(d.name)) continue;
          const inner = module ?? (d.name !== "Sources" && (here || /[\\/]Sources$/.test(dir)) ? d.name : undefined);
          walk(path, inner, here && !module);
        } else if (d.name.endsWith(".swift") && d.name !== "Package.swift") this.load(path, module ?? "");
      }
    };
    walk(root, undefined, false);
    for (const m of this.modules.values()) {
      for (const u of m.scope.values()) {
        for (const app of u) if (app.kind === "type" && app.inherits.includes("App")) for (const r of this.refsOf(app)) this.screens.add(r);
      }
    }
  }

  private moduleNamed(name: string): Module {
    let m = this.modules.get(name);
    if (!m) {
      m = { name, scope: new Map(), extensions: new Map(), members: new Map(), previews: [] };
      this.modules.set(name, m);
    }
    return m;
  }

  private load(abs: string, moduleName: string): void {
    const text = readFileSync(abs, "utf8");
    const tree = parse("swift", text);
    const module = this.moduleNamed(moduleName);
    const file: SwiftFile = { abs, rel: this.rel(abs), text, tree, module, imports: [], items: [], units: [] };
    this.files.set(file.rel, file);
    const txt = (n: Syntax) => text.slice(n.start, n.end);
    const push = (map: Map<string, Unit[]>, key: string, u: Unit) => map.set(key, [...(map.get(key) ?? []), u]);

    tree.children.forEach((n, i) => {
      if (n.type === "import_declaration") {
        file.items.push({ from: n.row + 1, to: n.endRow + 1, import: true });
        const id = n.children.find((c) => c.type === "identifier");
        if (id) file.imports.push(txt(id));
        return;
      }
      let kind: UnitKind | undefined;
      let names: string[] = [];
      let extended: string | undefined;
      if (n.type === "class_declaration" || n.type === "protocol_declaration") {
        const k = child(n, "declaration_kind");
        const name = child(n, "name");
        const nameText = name && (name.type === "user_type" ? txt(name.children.find((c) => c.type === "type_identifier") ?? name) : txt(name));
        if (!nameText) return;
        if (k && txt(k) === "extension") {
          kind = "extension";
          extended = nameText;
          names = [nameText];
        } else if (!k || TYPE_KINDS.has(txt(k))) {
          kind = "type";
          names = [nameText];
        }
      } else if (n.type === "typealias_declaration") {
        const name = child(n, "name");
        if (name) [kind, names] = ["type", [txt(name)]];
      } else if (n.type === "function_declaration") {
        const name = child(n, "name");
        if (name) [kind, names] = ["func", [txt(name)]];
      } else if (n.type === "property_declaration") {
        names = n.children.filter((c) => c.field === "name").flatMap((p) => p.children.filter((c) => c.field === "bound_identifier").map(txt));
        if (names.length) kind = "var";
      } else if (n.type === "macro_invocation" && n.children.some((c) => c.type === "simple_identifier" && txt(c) === "Preview")) {
        const title = findDeep(n, (c) => c.type === "line_str_text");
        [kind, names] = ["preview", [title ? txt(title) : "Preview"]];
      }
      if (!kind) return;

      const inherits = n.children
        .filter((c) => c.type === "inheritance_specifier")
        .flatMap((c) => c.children.filter((x) => x.field === "inherits_from"))
        .map((t) => txt(t.children.find((c) => c.type === "type_identifier") ?? t));
      const modifiers = n.children.find((c) => c.type === "modifiers");
      const isPrivate = !!modifiers && /\b(private|fileprivate)\b/.test(txt(modifiers));
      const name = kind === "extension" ? `extension ${extended}` : kind === "preview" ? `#Preview ${names[0]}` : names[0]!;
      const unit: Unit = { file, kind, name, names, extends: extended, inherits, private: isPrivate, node: n, from: docStart(tree.children, i) + 1, to: n.endRow + 1, line: n.row + 1 };
      file.units.push(unit);
      file.items.push({ from: unit.from, to: unit.to, unit });
      if (kind === "preview") module.previews.push(unit);
      else if (kind !== "extension") for (const x of names) push(module.scope, x, unit);
    });
    file.items.sort((a, b) => a.from - b.from);
  }

  /** Extensions are sorted once every file is loaded: whether the extended type is local decides what they are. */
  private extensionsReady = false;
  private sortExtensions(): void {
    if (this.extensionsReady) return;
    this.extensionsReady = true;
    for (const u of this.allUnits()) {
      if (u.kind !== "extension") continue;
      const m = u.file.module;
      if (m.scope.get(u.extends!)?.some((t) => t.kind === "type")) m.extensions.set(u.extends!, [...(m.extensions.get(u.extends!) ?? []), u]);
      else {
        // An extension of SwiftUI's View or Color: its members are reached by name, wherever they're called.
        const body = child(u.node, "body");
        for (const d of body?.children ?? []) {
          const name = d.type === "function_declaration" ? child(d, "name") : d.type === "property_declaration" ? findDeep(d, (c) => c.field === "bound_identifier") : undefined;
          if (name) {
            const key = u.file.text.slice(name.start, name.end);
            m.members.set(key, [...new Set([...(m.members.get(key) ?? []), u])]);
          }
        }
      }
    }
  }

  // ── references ───────────────────────────────────────────────────────

  /** A name as this file sees it: its own private declarations first, then the module's, then imported local modules'. */
  private lookup(file: SwiftFile, name: string): Unit[] {
    const own = file.module.scope.get(name);
    const visible = (own ?? []).filter((u) => !u.private || u.file === file);
    if (visible.length) return visible;
    for (const imp of file.imports) {
      const m = this.modules.get(imp);
      const hit = m && m !== file.module ? (m.scope.get(name) ?? []).filter((u) => !u.private) : [];
      if (hit.length) return hit;
    }
    return [];
  }

  protected refsOf(u: Unit): Set<Unit> {
    const cached = this.refCache.get(u);
    if (cached) return cached;
    this.sortExtensions();
    const out = new Set<Unit>();
    const file = u.file;
    const txt = (n: Syntax) => file.text.slice(n.start, n.end);
    const add = (units: Unit[] | undefined) => {
      for (const x of units ?? []) {
        if (x === u || (x.file.module !== file.module && x.private)) continue;
        out.add(x);
        // A type reached is reached with its extensions.
        if (x.kind === "type") for (const e of x.file.module.extensions.get(x.names[0]!) ?? []) if (e !== u) out.add(e);
      }
    };
    const member = (name: string) => {
      const hits = file.module.members.get(name);
      if (hits && hits.length === 1) add(hits);
    };
    const walk = (n: Syntax, parent?: Syntax): void => {
      switch (n.type) {
        case "comment":
        case "multiline_comment":
        case "value_argument_label":
        case "pattern":
          return;
        case "parameter":
          for (const c of n.children) if (c.type !== "simple_identifier") walk(c, n);
          return;
        case "navigation_suffix": {
          const s = child(n, "suffix");
          if (s?.type === "simple_identifier") member(txt(s));
          return;
        }
        case "simple_identifier":
          // `.headline` and `.freshness()` name members; everything else names something in scope.
          if (parent?.type === "prefix_expression" && parent.children[0]?.type === ".") member(txt(n));
          else if (!(parent?.type === "function_declaration" && n.field === "name")) add(this.lookup(file, txt(n)));
          return;
        case "type_identifier":
          add(this.lookup(file, txt(n)).filter((x) => x.kind === "type"));
          return;
      }
      // An extension's own `extension T` names the type it belongs to, which isn't a use of it.
      for (const c of n.children) if (!(u.kind === "extension" && n === u.node && c.field === "name")) walk(c, n);
    };
    walk(u.node);
    this.refCache.set(u, out);
    return out;
  }

  protected isReferrer(u: Unit): boolean {
    return u.kind !== "preview";
  }

  /** A view's previews come with it, as its examples. */
  protected companions(roots: Set<Unit>): Unit[] {
    const modules = new Set([...roots].map((u) => u.file.module));
    return [...modules].flatMap((m) => m.previews.filter((p) => [...this.refsOf(p)].some((r) => roots.has(r))));
  }

  protected members(u: Unit): Unit[] {
    this.sortExtensions();
    return u.kind === "type" ? [u, ...(u.file.module.extensions.get(u.names[0]!) ?? [])] : [u];
  }

  protected ownerOf(u: Unit): string | undefined {
    const type = u.kind === "type" ? u.names[0] : u.kind === "extension" && u.file.module.extensions.get(u.extends!)?.includes(u) ? u.extends : undefined;
    return type && `${u.file.module.name}:${type}`;
  }

  protected usesImports(_u: Unit): boolean {
    return true;
  }

  // ── discovery ────────────────────────────────────────────────────────

  discover(): Candidate[] {
    const out: Candidate[] = [];
    for (const file of this.files.values()) {
      for (const u of file.units) {
        if (u.kind !== "type" || !u.inherits.some((i) => VIEWS.has(i))) continue;
        out.push({
          file: file.rel,
          symbol: u.names[0]!,
          kind: this.screens.has(u) ? "screen" : "component",
          exported: !u.private,
          default: false,
          line: u.line,
        });
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
}
