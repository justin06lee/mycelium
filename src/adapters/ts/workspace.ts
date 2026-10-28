import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ImportDeclaration,
  Node,
  Project,
  type SourceFile,
  type Statement,
  SyntaxKind,
  ts,
} from "ts-morph";
import { codeTokens, hash, normalizeStyle } from "../../fingerprint.ts";
import type { Candidate, CandidateKind, Chunk, RootRef, Slice, SliceOptions, Workspace } from "../../types.ts";

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".next", ".turbo", ".vercel",
  "src-tauri", "target", "coverage", ".mycelium", ".git",
]);
const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less"]);
const TEXT_EXT = new Set([".svg", ".json", ".txt", ".md", ".html"]);
const UI_FILE = /\.[jt]sx$/;
const TEST_FILE = /\.(test|spec|stories)\.[jt]sx?$/;
const MAX_ASSET = 256 * 1024;
const JSX_KINDS = new Set([SyntaxKind.JsxElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxFragment]);

interface Edge {
  to: string;
  kind: "import" | "reexport" | "dynamic" | "asset";
  /** Names taken from the target: a declared name, "default", or "*" for all of it. */
  symbols: string[];
}

interface Decl {
  name: string;
  stmt: Statement;
  default: boolean;
  exported: boolean;
}

interface FileIndex {
  decls: Map<string, Decl>;
  imports: Map<string, ImportDeclaration>;
}

/** Loads every tsconfig a project uses: Next.js has one, electron-vite and Tauri templates split into references. */
function tsconfigs(root: string): string[] {
  const base = join(root, "tsconfig.json");
  if (!existsSync(base)) return [];
  const config = ts.readConfigFile(base, ts.sys.readFile).config ?? {};
  const refs = ((config.references ?? []) as { path: string }[])
    .map((r) => {
      const p = resolve(root, r.path);
      return p.endsWith(".json") ? p : join(p, "tsconfig.json");
    })
    .filter((p) => existsSync(p));
  return [base, ...refs];
}

export function isTsWorkspace(root: string): boolean {
  return existsSync(join(root, "tsconfig.json")) || existsSync(join(root, "package.json"));
}

export class TsWorkspace implements Workspace {
  private files = new Map<string, SourceFile>();
  private indexes = new Map<string, FileIndex>();
  private edgeCache = new Map<string, Edge[]>();
  private reverse?: Map<string, { from: string; edge: Edge }[]>;

  constructor(readonly root: string) {
    const configs = tsconfigs(root);
    const projects: Project[] = [];
    for (const tsConfigFilePath of configs) {
      try {
        projects.push(new Project({ tsConfigFilePath }));
      } catch {
        // A config that doesn't parse shouldn't stop the others from loading.
      }
    }
    if (projects.length === 0) {
      const project = new Project({
        compilerOptions: {
          allowJs: true,
          jsx: ts.JsxEmit.Preserve,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
      });
      project.addSourceFilesAtPaths([`${root}/**/*.{ts,tsx,js,jsx}`, `!${root}/**/node_modules/**`]);
      projects.push(project);
    }
    for (const project of projects) {
      for (const sf of project.getSourceFiles()) {
        const path = sf.getFilePath();
        if (this.isLocal(path) && !this.files.has(path)) this.files.set(path, sf);
      }
    }
  }

  // ── paths ────────────────────────────────────────────────────────────

  private rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  private abs(rel: string): string {
    return resolve(this.root, rel);
  }

  private isLocal(abs: string): boolean {
    const r = relative(this.root, abs);
    if (r.startsWith("..") || isAbsolute(r) || abs.endsWith(".d.ts")) return false;
    return !r.split(sep).some((seg) => SKIP_DIRS.has(seg));
  }

  /** Resolves imports TypeScript itself can't, like CSS, through relative paths and tsconfig `paths`. */
  private resolveAsset(spec: string, from: SourceFile): string | undefined {
    const found = (p: string) => (existsSync(p) && statSync(p).isFile() && this.isLocal(p) ? p : undefined);
    if (spec.startsWith(".") || spec.startsWith("/")) return found(resolve(dirname(from.getFilePath()), spec));
    const opts = from.getProject().getCompilerOptions();
    const base =
      opts.baseUrl ??
      (opts.pathsBasePath as string | undefined) ??
      (opts.configFilePath ? dirname(opts.configFilePath as string) : this.root);
    for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
      const star = pattern.indexOf("*");
      const prefix = star < 0 ? pattern : pattern.slice(0, star);
      const suffix = star < 0 ? "" : pattern.slice(star + 1);
      if (star < 0 ? spec !== pattern : !(spec.startsWith(prefix) && spec.endsWith(suffix))) continue;
      const rest = star < 0 ? "" : spec.slice(prefix.length, spec.length - suffix.length);
      for (const t of targets) {
        const hit = found(resolve(base, t.replace("*", rest)));
        if (hit) return hit;
      }
    }
    return undefined;
  }

  // ── declarations ─────────────────────────────────────────────────────

  private index(sf: SourceFile): FileIndex {
    const cached = this.indexes.get(sf.getFilePath());
    if (cached) return cached;
    const decls = new Map<string, Decl>();
    const imports = new Map<string, ImportDeclaration>();
    let defaultName: string | undefined;
    const add = (name: string, stmt: Statement, isDefault = false) => {
      const exported = Node.isExportable(stmt) ? stmt.isExported() : false;
      decls.set(name, { name, stmt, default: isDefault, exported });
    };
    for (const stmt of sf.getStatements()) {
      if (Node.isImportDeclaration(stmt)) {
        const def = stmt.getDefaultImport();
        if (def) imports.set(def.getText(), stmt);
        const ns = stmt.getNamespaceImport();
        if (ns) imports.set(ns.getText(), stmt);
        for (const spec of stmt.getNamedImports()) imports.set((spec.getAliasNode() ?? spec.getNameNode()).getText(), stmt);
      } else if (
        Node.isFunctionDeclaration(stmt) ||
        Node.isClassDeclaration(stmt) ||
        Node.isInterfaceDeclaration(stmt) ||
        Node.isTypeAliasDeclaration(stmt) ||
        Node.isEnumDeclaration(stmt)
      ) {
        const isDefault = Node.isExportable(stmt) && stmt.isDefaultExport();
        const name = stmt.getName() ?? (isDefault ? "default" : undefined);
        if (!name) continue;
        add(name, stmt, isDefault);
        if (isDefault) defaultName = name;
      } else if (Node.isVariableStatement(stmt)) {
        for (const d of stmt.getDeclarations()) {
          const nameNode = d.getNameNode();
          const ids = Node.isIdentifier(nameNode) ? [nameNode] : nameNode.getDescendantsOfKind(SyntaxKind.Identifier);
          for (const id of ids) add(id.getText(), stmt);
        }
      } else if (Node.isExportAssignment(stmt) && !stmt.isExportEquals()) {
        const expr = stmt.getExpression();
        if (Node.isIdentifier(expr)) defaultName = expr.getText();
        else {
          add("default", stmt, true);
          defaultName = "default";
        }
      }
    }
    const def = defaultName ? decls.get(defaultName) : undefined;
    if (def) {
      def.default = true;
      def.exported = true;
    }
    const idx = { decls, imports };
    this.indexes.set(sf.getFilePath(), idx);
    return idx;
  }

  private findDecl(sf: SourceFile, symbol: string): Decl | undefined {
    const { decls } = this.index(sf);
    if (symbol === "default") return [...decls.values()].find((d) => d.default);
    return decls.get(symbol);
  }

  private isComponent(d: Decl): boolean {
    if (!/^[A-Z]/.test(d.name) && d.name !== "default") return false;
    const s = d.stmt;
    let body: Node | undefined;
    if (Node.isFunctionDeclaration(s) || Node.isExportAssignment(s)) body = s;
    else if (Node.isClassDeclaration(s)) body = /Component/.test(s.getExtends()?.getText() ?? "") ? s : undefined;
    else if (Node.isVariableStatement(s)) {
      const init = s.getDeclarations().find((v) => v.getName() === d.name)?.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init) || Node.isCallExpression(init))) body = init;
    }
    return body?.getFirstDescendant((n) => JSX_KINDS.has(n.getKind())) !== undefined;
  }

  private kindOf(file: string, d: Decl): CandidateKind {
    const parts = file.split("/");
    const name = basename(file, extname(file));
    if (parts.includes("app") && name === "page" && d.default) return "screen";
    if (parts.includes("app") && name === "layout" && d.default) return "layout";
    if (parts.includes("pages") && d.default) return name === "_app" || name === "_document" ? "layout" : "screen";
    return "component";
  }

  discover(): Candidate[] {
    const out: Candidate[] = [];
    for (const [path, sf] of this.files) {
      if (!UI_FILE.test(path) || TEST_FILE.test(path)) continue;
      const file = this.rel(path);
      for (const d of this.index(sf).decls.values()) {
        if (!this.isComponent(d)) continue;
        out.push({
          file,
          symbol: d.name,
          kind: this.kindOf(file, d),
          exported: d.exported,
          default: d.default,
          line: d.stmt.getStartLineNumber(),
        });
      }
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  // ── the import graph ─────────────────────────────────────────────────

  /**
   * Outgoing edges of a file. `keep` narrows which import bindings count, and `scope` which
   * statements are searched for dynamic `import()`, so a root can be traced without its neighbours.
   */
  private edges(sf: SourceFile, keep?: (imp: ImportDeclaration, local: string) => boolean, scope?: Node[]): Edge[] {
    const whole = !keep;
    if (whole) {
      const cached = this.edgeCache.get(sf.getFilePath());
      if (cached) return cached;
    }
    const out: Edge[] = [];
    const push = (to: string | undefined, kind: Edge["kind"], symbols: string[]) => {
      if (!to || !this.isLocal(to) || symbols.length === 0) return;
      const same = out.find((e) => e.to === to && e.kind === kind);
      if (same) same.symbols.push(...symbols.filter((s) => !same.symbols.includes(s)));
      else out.push({ to, kind, symbols: [...new Set(symbols)] });
    };

    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      const bindings: { local: string; imported: string; node: Node }[] = [];
      const def = imp.getDefaultImport();
      if (def) bindings.push({ local: def.getText(), imported: "default", node: def });
      for (const spec of imp.getNamedImports()) {
        const local = (spec.getAliasNode() ?? spec.getNameNode()).getText();
        bindings.push({ local, imported: spec.getName(), node: spec.getAliasNode() ?? spec.getNameNode() });
      }
      const ns = imp.getNamespaceImport();
      if (ns) bindings.push({ local: ns.getText(), imported: "*", node: ns });

      const used = keep ? bindings.filter((b) => keep(imp, b.local)) : bindings;
      const sideEffect = bindings.length === 0;
      if (keep && !sideEffect && used.length === 0) continue;
      if (keep && sideEffect && !keep(imp, "")) continue;

      if (!target) {
        push(this.resolveAsset(imp.getModuleSpecifierValue(), sf), "asset", ["*"]);
        continue;
      }
      if (sideEffect) {
        push(target.getFilePath(), "import", ["*"]);
        continue;
      }
      const barrel = target.getExportDeclarations().some((e) => e.hasModuleSpecifier());
      for (const b of used) {
        if (barrel && b.imported !== "*") {
          // Look through index files to the file that actually declares the name.
          const sym = b.node.getSymbol();
          const real = sym?.isAlias() ? sym.getAliasedSymbol() : sym;
          const declFile = real?.getDeclarations()[0]?.getSourceFile();
          if (real && declFile && this.files.has(declFile.getFilePath())) {
            push(declFile.getFilePath(), "import", [real.getName()]);
            continue;
          }
        }
        push(target.getFilePath(), "import", [b.imported]);
      }
    }

    if (whole) {
      for (const exp of sf.getExportDeclarations()) {
        const target = exp.getModuleSpecifierSourceFile();
        if (!target) continue;
        const named = exp.getNamedExports().map((n) => n.getName());
        push(target.getFilePath(), "reexport", named.length ? named : ["*"]);
      }
    }

    const opts = sf.getProject().getCompilerOptions();
    for (const node of scope ?? [sf]) {
      for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
        const arg = call.getArguments()[0];
        if (!arg || !Node.isStringLiteral(arg)) continue;
        const hit = ts.resolveModuleName(arg.getLiteralValue(), sf.getFilePath(), opts, ts.sys).resolvedModule;
        push(hit?.resolvedFileName, "dynamic", ["*"]);
      }
    }

    if (whole) this.edgeCache.set(sf.getFilePath(), out);
    return out;
  }

  private edgesOf(abs: string): Edge[] {
    const sf = this.files.get(abs);
    return sf ? this.edges(sf) : [];
  }

  /** Who imports each file. Re-exports and tests don't count: passing a name along isn't using it. */
  private importers(): Map<string, { from: string; edge: Edge }[]> {
    if (this.reverse) return this.reverse;
    const rev = new Map<string, { from: string; edge: Edge }[]>();
    for (const [from, sf] of this.files) {
      if (TEST_FILE.test(from)) continue;
      for (const edge of this.edges(sf)) {
        if (edge.kind === "reexport") continue;
        const list = rev.get(edge.to) ?? [];
        list.push({ from, edge });
        rev.set(edge.to, list);
      }
    }
    this.reverse = rev;
    return rev;
  }

  usedBy(root: RootRef): string[] {
    const abs = this.abs(root.file);
    const sf = this.files.get(abs);
    const d = sf && this.findDecl(sf, root.symbol);
    const names = new Set(["*", root.symbol, ...(d?.default ? ["default"] : [])]);
    const users = (this.importers().get(abs) ?? []).filter(({ edge }) => edge.symbols.some((s) => names.has(s)));
    return [...new Set(users.map((u) => this.rel(u.from)))].sort();
  }

  // ── slicing ──────────────────────────────────────────────────────────

  slice(root: RootRef, opts: SliceOptions): Slice | undefined {
    const rootAbs = this.abs(root.file);
    const sf = this.files.get(rootAbs);
    const decl = sf && this.findDecl(sf, root.symbol);
    if (!sf || !decl) return undefined;
    const idx = this.index(sf);

    const bounds = new Map<string, Set<string>>();
    for (const b of opts.boundaries) {
      const abs = this.abs(b.file);
      const set = bounds.get(abs) ?? new Set();
      set.add(b.symbol);
      const bsf = this.files.get(abs);
      if (bsf && this.findDecl(bsf, b.symbol)?.default) set.add("default");
      bounds.set(abs, set);
    }
    const uses: RootRef[] = [];
    const addUse = (abs: string, symbol: string) => {
      const file = this.rel(abs);
      const bsf = this.files.get(abs);
      const name = symbol === "default" && bsf ? (this.findDecl(bsf, "default")?.name ?? symbol) : symbol;
      if (!uses.some((u) => u.file === file && u.symbol === name)) uses.push({ file, symbol: name });
    };

    // 1. Within the root's own file: the root plus the local declarations and imports it reaches.
    const included = new Set<Statement>([decl.stmt]);
    const usedLocals = new Set<string>();
    const queue: Statement[] = [decl.stmt];
    const rootBounds = bounds.get(rootAbs);
    while (queue.length) {
      const stmt = queue.pop()!;
      for (const id of stmt.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const name = id.getText();
        const local = idx.decls.get(name);
        if (local && !included.has(local.stmt)) {
          if (rootBounds?.has(local.name)) addUse(rootAbs, local.name);
          else {
            included.add(local.stmt);
            queue.push(local.stmt);
          }
        }
        if (idx.imports.has(name)) usedLocals.add(name);
      }
    }
    const componentsHere = [...idx.decls.values()].filter((d) => this.isComponent(d)).length;
    // A bare `import "./x.css"` can't be pinned to one component, so it only joins a file's sole component.
    const keep = (_imp: ImportDeclaration, local: string) => (local === "" ? componentsHere <= 1 : usedLocals.has(local));
    const rootEdges = this.edges(sf, keep, [...included]);

    // 2. Everything reachable from there, stopping at other registered components.
    const reached = new Set<string>();
    const stack: string[] = [];
    const visit = (edge: Edge) => {
      if (edge.to === rootAbs) return;
      const b = bounds.get(edge.to);
      if (b) {
        const hits = edge.symbols.filter((s) => b.has(s) || s === "*");
        for (const s of hits) for (const sym of s === "*" ? b : [s]) addUse(edge.to, sym);
        if (hits.length === edge.symbols.length) return;
      }
      if (!reached.has(edge.to)) {
        reached.add(edge.to);
        stack.push(edge.to);
      }
    };
    rootEdges.forEach(visit);
    while (stack.length) this.edgesOf(stack.pop()!).forEach(visit);

    // 3. Keep only what nothing else reaches: the largest set whose importers are all inside it.
    const owned = new Set(reached);
    const importers = this.importers();
    for (let changed = true; changed; ) {
      changed = false;
      for (const f of owned) {
        const outside = (importers.get(f) ?? []).some(({ from }) => from !== rootAbs && !owned.has(from));
        if (outside) {
          owned.delete(f);
          changed = true;
        }
      }
    }
    const shared = new Set<string>();
    for (const e of [...rootEdges, ...[...owned].flatMap((f) => this.edgesOf(f))]) {
      if (e.to !== rootAbs && !owned.has(e.to) && !bounds.has(e.to)) shared.add(this.rel(e.to));
    }

    // 4. The code itself.
    const chunks: Chunk[] = [this.rootChunk(sf, included, keep)];
    const extra = [...owned].map((f) => this.rel(f)).sort();
    for (const pin of opts.pins) if (!extra.includes(pin) && pin !== root.file) extra.push(pin);
    for (const file of extra) {
      const chunk = this.fileChunk(this.abs(file));
      if (chunk) chunks.push(chunk);
    }

    return {
      root: { file: root.file, symbol: decl.name, line: decl.stmt.getStartLineNumber(), default: decl.default },
      chunks,
      uses,
      shared: [...shared].sort(),
      ...this.shapeOf(decl),
    };
  }

  rootShape(root: RootRef): { shape: string; rootText: string } | undefined {
    const sf = this.files.get(this.abs(root.file));
    const decl = sf && this.findDecl(sf, root.symbol);
    return decl && this.shapeOf(decl);
  }

  private shapeOf(decl: Decl): { shape: string; rootText: string } {
    const tokens = codeTokens(decl.stmt.getText());
    return {
      shape: hash(tokens.map((t) => (t === decl.name ? "$" : t)).join(" ")),
      rootText: tokens.join(" "),
    };
  }

  private rootChunk(sf: SourceFile, included: Set<Statement>, keep: (imp: ImportDeclaration, local: string) => boolean): Chunk {
    const idx = this.index(sf);
    const statements = sf.getStatements();
    const parts = statements.filter((s) => {
      if (included.has(s)) return true;
      if (!Node.isImportDeclaration(s)) return false;
      const locals = [...idx.imports].filter(([, imp]) => imp === s).map(([local]) => local);
      return locals.length === 0 ? keep(s, "") : locals.some((l) => keep(s, l));
    });
    const file = this.rel(sf.getFilePath());
    if (parts.length === statements.length) {
      const text = sf.getFullText();
      return { file, kind: "code", text, hash: hash(codeTokens(text).join(" ")) };
    }
    // Consecutive kept statements form one range, blank lines between them included; anything left out splits it.
    const kept = new Set(parts);
    const ranges: [number, number][] = [];
    let open = false;
    for (const s of statements) {
      if (!kept.has(s)) {
        open = false;
        continue;
      }
      const start = sf.getLineAndColumnAtPos(s.getStart(true)).line;
      const end = s.getEndLineNumber();
      const last = ranges[ranges.length - 1];
      if (open && last) last[1] = end;
      else ranges.push([start, end]);
      open = true;
    }
    const lines = sf.getFullText().split("\n");
    const text = ranges.map(([a, b]) => lines.slice(a - 1, b).join("\n")).join("\n// …\n");
    const tokens = parts.flatMap((s) => codeTokens(s.getText(true)));
    return { file, kind: "code", ranges, text, hash: hash(tokens.join(" ")) };
  }

  private fileChunk(abs: string): Chunk | undefined {
    const file = this.rel(abs);
    const sf = this.files.get(abs);
    if (sf) {
      const text = sf.getFullText();
      return { file, kind: "code", text, hash: hash(codeTokens(text).join(" ")) };
    }
    if (!existsSync(abs)) return undefined;
    const ext = extname(abs).toLowerCase();
    const size = statSync(abs).size;
    if (STYLE_EXT.has(ext) || (TEXT_EXT.has(ext) && size <= MAX_ASSET)) {
      const text = readFileSync(abs, "utf8");
      return { file, kind: STYLE_EXT.has(ext) ? "style" : "asset", text, hash: hash(normalizeStyle(text)) };
    }
    return { file, kind: "asset", hash: hash(readFileSync(abs).toString("base64")) };
  }
}
