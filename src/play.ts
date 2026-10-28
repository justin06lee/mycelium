import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BunPlugin } from "bun";
import { ts } from "ts-morph";
import { Library } from "./engine.ts";
import { openWorkspace } from "./index.ts";
import { Store } from "./store.ts";
import { Styles } from "./styles.ts";
import type { Candidate, Config, Entry } from "./types.ts";

/** Where the generated entry modules go: inside the project, so its node_modules and tsconfig paths resolve. */
export const PLAY_DIR = ".mycelium/play";
const SKIP = new Set(["node_modules", "dist", "build", "out", "release", "target", "coverage", "src-tauri", "vendor"]);
const IGNORED = /(^|[\\/])(node_modules|\.git|\.next|dist|build|out|target)([\\/]|$)|\.mycelium[\\/]play/;

export function readConfig(root: string): Config {
  const path = join(root, ".mycelium", "config.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Config) : {};
}

/** Where an app loads its global CSS: Next.js layouts and _app, and Vite, Electron and Wails entries. */
const APP_ENTRIES = ["app/layout", "src/app/layout", "pages/_app", "src/pages/_app", "src/main", "src/index", "src/renderer/src/main", "frontend/src/main"];

/** The stylesheets the app's entry imports for their side effects, such as app/globals.css. */
export function globalCss(root: string): string[] {
  const found: string[] = [];
  for (const base of APP_ENTRIES) {
    const file = [".tsx", ".jsx", ".ts", ".js"].map((ext) => join(root, base + ext)).find(existsSync);
    if (!file) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*import\s+["']([^"']+\.(?:css|scss|sass|less))["']/gm)) {
      const spec = m[1]!;
      if (!spec.startsWith(".")) continue;
      const path = resolve(dirname(file), spec);
      if (existsSync(path)) found.push(relative(root, path).split(sep).join("/"));
    }
  }
  return [...new Set(found)];
}

/** The render settings with defaults filled in: global CSS from the app's entry, setup from .mycelium/setup.ts(x). */
export function renderConfig(root: string): Config {
  const config = readConfig(root);
  const setup = [".mycelium/setup.ts", ".mycelium/setup.tsx", ".mycelium/setup.js"].filter((f) => existsSync(join(root, f)));
  return {
    ...config,
    render: { ...config.render, css: config.render?.css ?? globalCss(root), setup: config.render?.setup ?? setup.slice(0, 1) },
  };
}

/** Where `name` resolves from the first of `dirs` that has it. */
function resolveIn(name: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    try {
      return Bun.resolveSync(name, dir);
    } catch {
      // Try the next place.
    }
  }
  return undefined;
}

interface Alias {
  pattern: RegExp;
  targets: string[];
  base: string;
}

/**
 * Path aliases from the tsconfigs the root one references. Bun reads the root tsconfig's paths itself, but
 * Vite and Electron templates keep theirs in a referenced tsconfig.web.json or tsconfig.app.json.
 */
export function referencedAliases(root: string): Alias[] {
  const read = (file: string) => (existsSync(file) ? ts.readConfigFile(file, ts.sys.readFile).config : undefined);
  const references: { path: string }[] = read(join(root, "tsconfig.json"))?.references ?? [];
  const aliases: Alias[] = [];
  for (const ref of references) {
    const path = resolve(root, ref.path);
    const file = path.endsWith(".json") ? path : join(path, "tsconfig.json");
    const options = read(file)?.compilerOptions ?? {};
    const base = resolve(dirname(file), options.baseUrl ?? ".");
    for (const [key, targets] of Object.entries((options.paths ?? {}) as Record<string, string[]>)) {
      const pattern = new RegExp(`^${key.replace(/[.+?^${}()|[\]\\/]/g, "\\$&").replace("*", "(.*)")}$`);
      aliases.push({ pattern, targets, base });
    }
  }
  return aliases;
}

function aliases(list: Alias[]): BunPlugin {
  return {
    name: "myc-aliases",
    setup(build) {
      if (list.length === 0) return;
      build.onResolve({ filter: new RegExp(list.map((a) => a.pattern.source).join("|")) }, (args) => {
        for (const a of list) {
          const m = args.path.match(a.pattern);
          if (!m) continue;
          for (const target of a.targets) {
            const path = resolveIn(join(a.base, target.replace("*", m[1] ?? "")), [a.base]);
            if (path) return { path };
          }
        }
        return undefined;
      });
    },
  };
}

/** Runs the project's own stylesheets through its pipeline; CSS modules keep their scoped names. */
function stylesheets(styles: Styles): BunPlugin {
  return {
    name: "myc-styles",
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        if (/[\\/]node_modules[\\/]/.test(args.path)) return undefined;
        const css = await styles.process(await Bun.file(args.path).text(), args.path);
        return css === undefined ? undefined : { contents: css, loader: "css" };
      });
    },
  };
}

/** `file#Symbol` as an import of `as` from a module one level inside .mycelium. */
function importOf(spec: string, as: string, isDefault: boolean): string {
  const at = spec.lastIndexOf("#");
  const file = at < 0 ? spec : spec.slice(0, at);
  const symbol = at < 0 ? "default" : spec.slice(at + 1);
  const from = JSON.stringify(`../../${file}`);
  return isDefault || symbol === "default" ? `import ${as} from ${from};` : `import { ${symbol} as ${as} } from ${from};`;
}

/**
 * The module that renders one component: every example, inside the project's wrapper, each behind an error
 * boundary. Examples are the entry's prop sets plus the named exports of .mycelium/examples/<slug>.tsx.
 */
export function entrySource(
  root: string,
  entry: Entry,
  target: Pick<Candidate, "symbol" | "default" | "kind"> & { callbacks?: string[] },
  config: Config,
): string {
  const wrapper = config.render?.wrapper;
  const fileExamples = existsSync(join(root, ".mycelium", "examples", `${entry.slug}.tsx`));
  return `// Generated by myc play for ${entry.slug}; rewritten on every render.
${(config.render?.setup ?? []).map((m) => `import ${JSON.stringify(`../../${m}`)};`).join("\n")}
import * as React from "react";
import { createRoot } from "react-dom/client";
${importOf(`${entry.root.file}#${target.symbol}`, "Component", target.default)}
${wrapper ? importOf(wrapper, "Wrapper", false) : "const Wrapper = React.Fragment;"}
${(config.render?.css ?? []).map((css) => `import ${JSON.stringify(`../../${css}`)};`).join("\n")}
${fileExamples ? `import * as file from ${JSON.stringify(`../examples/${entry.slug}.tsx`)};` : "const file = {};"}

// Next.js hands screens their params and searchParams as promises that also read as plain objects.
const screen = ${target.kind !== "component"};
const settled = (value = {}) => Object.assign(Promise.resolve(value), value);
// Function props an example leaves out are filled with ones that log their calls.
const callbacks = Object.fromEntries(
  ${JSON.stringify(target.callbacks ?? [])}.map((name) => [name, (...args) => console.info(${JSON.stringify(`${entry.slug} ·`)}, name, ...args)]),
);
const propsOf = (example = {}) => {
  const p = { ...callbacks, ...example };
  return screen ? { ...p, params: settled(p.params), searchParams: settled(p.searchParams) } : p;
};

// React renders async components (server components) only on a server, so they're awaited here instead.
function Awaited({ props }) {
  const [state, setState] = React.useState(null);
  React.useEffect(() => {
    Promise.resolve(Component(props)).then((element) => setState({ element }), (error) => setState({ error }));
  }, []);
  if (state?.error) throw state.error;
  return state?.element ?? null;
}
const show = (p) => {
  const props = propsOf(p);
  return Component.constructor?.name === "AsyncFunction" ? <Awaited props={props} /> : <Component {...props} />;
};

const examples = [
  ...${JSON.stringify(entry.examples ?? [])}.map((e) => ({ name: e.name, render: () => show(e.props) })),
  ...Object.entries(file)
    .filter(([, Example]) => typeof Example === "function")
    .map(([name, Example]) => ({ name, render: () => <Example /> })),
];
if (examples.length === 0) examples.push({ name: "default", render: () => show({}) });

class Boundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <pre className="myc-error">{String(this.state.error?.stack ?? this.state.error)}</pre>;
  }
}

const only = new URLSearchParams(location.search).get("example");
const shown = only ? examples.filter((e) => e.name === only) : examples;
createRoot(document.getElementById("root")).render(
  <Wrapper>
    {shown.length === 0 ? <pre className="myc-error">no example named {only}</pre> : null}
    {shown.map((e) => (
      <section key={e.name} data-example={e.name} className="myc-example">
        {shown.length > 1 ? <div className="myc-label">{e.name}</div> : null}
        <Boundary>{e.render()}</Boundary>
      </section>
    ))}
  </Wrapper>,
);
`;
}

/** Framework modules that only work inside their own runtime, replaced by inert stand-ins. */
const STUBS: Record<string, string> = {
  "next/link": `import * as React from "react";
export default React.forwardRef(function Link({ href, prefetch, replace, scroll, shallow, passHref, legacyBehavior, locale, ...props }, ref) {
  return React.createElement("a", { ref, href: typeof href === "string" ? href : (href?.pathname ?? "#"), ...props });
});`,
  "next/image": `import * as React from "react";
export default function Image({ src, fill, priority, quality, placeholder, blurDataURL, loader, unoptimized, ...props }) {
  const style = fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...props.style } : props.style;
  return React.createElement("img", { ...props, src: typeof src === "string" ? src : src?.src, style });
}`,
  "next/navigation": `const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
export const useRouter = () => router;
export const usePathname = () => "/";
export const useSearchParams = () => new URLSearchParams(location.search);
export const useParams = () => ({});
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export function redirect() {}
export function permanentRedirect() {}
export function notFound() {}`,
  "next/router": `const router = { pathname: "/", route: "/", asPath: "/", query: {}, isReady: true, push: async () => true, replace: async () => true, back() {}, reload() {}, prefetch: async () => {}, events: { on() {}, off() {}, emit() {} } };
export const useRouter = () => router;
export default router;`,
  "server-only": "",
  "client-only": "",
};

/** The names a module exports, read from its text: enough for the plain exports server action files use. */
function exportNames(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)|export\s+(?:const|let|var)\s+([\w$]+)/g)) names.add((m[1] ?? m[2])!);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && name !== "type" && !part.trim().startsWith("type ")) names.add(name);
    }
  }
  if (/export\s+default\b/.test(code)) names.add("default");
  return [...names];
}

const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/;

const stubs: BunPlugin = {
  name: "myc-stubs",
  setup(build) {
    // Server actions run on the server: the browser gets functions that only say so, and none of their imports.
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
      if (/[\\/]node_modules[\\/]/.test(args.path)) return undefined;
      const code = await Bun.file(args.path).text();
      if (!USE_SERVER.test(code)) return undefined;
      const action = (name: string) =>
        `async () => { console.warn(${JSON.stringify(`${name} is a server action; it doesn't run in the playground`)}); }`;
      const contents = exportNames(code)
        .map((n) => (n === "default" ? `export default ${action(n)};` : `export const ${n} = ${action(n)};`))
        .join("\n");
      return { contents, loader: "js" };
    });
    const names = Object.keys(STUBS).map((n) => n.replace(/[/-]/g, "\\$&"));
    build.onResolve({ filter: new RegExp(`^(${names.join("|")})$`) }, (args) => ({ path: args.path, namespace: "myc-stub" }));
    build.onLoad({ filter: /.*/, namespace: "myc-stub" }, (args) => ({ contents: STUBS[args.path]!, loader: "jsx" }));
  },
};

/** Desktop bridges (Electron preload, Wails, Tauri) don't exist in a browser: calls resolve to nothing. */
/** The names an Electron preload exposes on window, read from its contextBridge.exposeInMainWorld calls. */
export function bridges(root: string): string[] {
  const names = new Set(["api", "electron", "go", "runtime"]);
  const walk = (dir: string, depth: number, inPreload: boolean) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith(".") || SKIP.has(d.name)) continue;
      const path = join(dir, d.name);
      const preload = inPreload || /preload/i.test(d.name);
      if (d.isDirectory() && depth < 5) walk(path, depth + 1, preload);
      else if (d.isFile() && preload && /\.[cm]?[jt]s$/.test(d.name)) {
        for (const m of readFileSync(path, "utf8").matchAll(/exposeInMainWorld\(\s*["'`]([\w$]+)["'`]/g)) names.add(m[1]!);
      }
    }
  };
  walk(root, 0, false);
  return [...names];
}

const SHIM = (names: string[]) => `(() => {
  const deep = () => new Proxy(function () {}, {
    get: (_, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : deep()),
    apply: () => Promise.resolve(undefined),
  });
  for (const k of ${JSON.stringify(names)}) if (!(k in window)) window[k] = deep();
  window.process ??= { env: { NODE_ENV: "development" } };
  window.__TAURI_INTERNALS__ ??= { invoke: () => Promise.resolve(null), transformCallback: () => 0, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } };
})();`;

const PAGE_CSS = `body{margin:0;padding:24px;font-family:system-ui,sans-serif}
.myc-example+.myc-example{margin-top:24px}
.myc-label{font:12px ui-monospace,monospace;color:#888;margin-bottom:8px}
.myc-error{font:12px/1.5 ui-monospace,monospace;color:#c0392b;white-space:pre-wrap;margin:0}`;

/** Reports the page's height to an embedding page, so iframes can fit their content. */
const RESIZE = (slug: string) => `new ResizeObserver(() => parent.postMessage({ myc: { slug: ${JSON.stringify(slug)}, height: document.documentElement.scrollHeight } }, "*")).observe(document.body);
new EventSource("/events").onmessage = () => location.reload();`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

interface Build {
  files: Map<string, Blob>;
  css: string[];
}

export interface Playground {
  url: string;
  stop(): void;
}

/** Serves every registered component, rendered live from the code with its examples, rebuilt on each request. */
export function play(root: string, opts: { port?: number; hostname?: string } = {}): Playground {
  const store = new Store(root);
  let library: Library | undefined;
  const lib = () => (library ??= new Library(openWorkspace(root), store));
  const builds = new Map<string, Build>();
  const styles = new Styles(root);
  const paths = referencedAliases(root);
  const shim = SHIM(bridges(root));
  const listeners = new Set<ReadableStreamDefaultController>();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(root, { recursive: true }, (_event, file) => {
    if (file && IGNORED.test(file)) return;
    library = undefined;
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of listeners) c.enqueue("data: change\n\n");
    }, 80);
  });

  /** Bundles one component; a string is the reason it can't render. */
  async function build(slug: string): Promise<Build | string> {
    const r = lib().resolve(slug);
    if (!r) return `no component named ${slug}`;
    if (r.status === "orphaned") return `${slug}'s root ${r.root.file}#${r.root.symbol} is gone; myc check says where it went`;
    const c = lib()
      .allCandidates()
      .find((c) => c.file === r.root.file && c.symbol === r.root.symbol);
    if (!c) return `${r.root.file}#${r.root.symbol} isn't a component, so there's nothing to render`;
    if (!c.exported) return `${r.root.file}#${r.root.symbol} isn't exported, so the playground can't import it`;
    const dir = join(root, PLAY_DIR);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
    const path = join(dir, `${slug}.tsx`);
    const callbacks = (lib().ws.props?.(r.root) ?? []).filter((p) => p.callable).map((p) => p.name);
    const source = entrySource(root, { ...r.entry, root: r.root }, { ...c, callbacks }, renderConfig(root));
    if (!existsSync(path) || readFileSync(path, "utf8") !== source) writeFileSync(path, source);
    try {
      const out = await Bun.build({
        entrypoints: [path],
        target: "browser",
        naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
        publicPath: `/out/${slug}/`,
        define: { "process.env.NODE_ENV": '"development"' },
        jsx: { runtime: "automatic" },
        plugins: [stubs, aliases(paths), stylesheets(styles)],
        throw: false,
      });
      if (!out.success) return out.logs.map((l) => String(l)).join("\n");
      const files = new Map(out.outputs.map((o) => [o.path.split(/[\\/]/).pop()!, o as Blob]));
      return { files, css: [...files.keys()].filter((f) => f.endsWith(".css")) };
    } catch (err) {
      return err instanceof AggregateError ? err.errors.map(String).join("\n") : String(err);
    }
  }

  async function page(slug: string): Promise<Response> {
    const b = await build(slug);
    if (typeof b !== "string") builds.set(slug, b);
    const head = typeof b === "string" ? "" : b.css.map((f) => `<link rel="stylesheet" href="/out/${slug}/${f}">`).join("");
    const body =
      typeof b === "string"
        ? `<pre class="myc-error">${esc(b)}</pre>`
        : `<div id="root"></div><script type="module" src="/out/${slug}/${slug}.js"></script>`;
    return html(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(slug)}</title>
<style>${PAGE_CSS}</style><script>${shim}</script>${head}</head><body>${body}<script>${RESIZE(slug)}</script></body></html>`);
  }

  function index(): Response {
    const cards = store
      .all()
      .map(
        (e) => `<article><header><a href="/c/${e.slug}">${esc(e.name)}</a><code>${e.slug}</code></header>
${e.note ? `<p>${esc(e.note)}</p>` : ""}<iframe src="/c/${e.slug}" data-slug="${e.slug}" loading="lazy"></iframe></article>`,
      )
      .join("\n");
    return html(`<!doctype html><html><head><meta charset="utf-8"><title>mycelium</title><style>
body{margin:0;padding:32px;font-family:system-ui,sans-serif;background:#f6f6f4;color:#222}
h1{font-size:18px;margin:0 0 24px}main{display:grid;gap:20px;align-items:start;grid-template-columns:repeat(auto-fill,minmax(360px,1fr))}
article{background:#fff;border:1px solid #e3e3df;border-radius:10px;overflow:hidden}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:12px 16px;border-bottom:1px solid #eee}
header a{font-weight:600;color:inherit;text-decoration:none}code{font-size:12px;color:#888}
p{margin:0;padding:8px 16px 0;font-size:13px;color:#555}iframe{display:block;width:100%;height:160px;border:0}
</style></head><body><h1>mycelium · ${store.all().length} components</h1><main>${cards || "<p>the library is empty; myc add registers components</p>"}</main>
<script>addEventListener("message", (e) => { const m = e.data?.myc; if (!m) return;
for (const f of document.querySelectorAll("iframe[data-slug='" + m.slug + "']")) f.style.height = Math.min(m.height, 640) + "px"; });</script></body></html>`);
  }

  const serve = (port: number) =>
    Bun.serve({
      port,
      hostname: opts.hostname ?? "localhost",
      idleTimeout: 0,
      fetch,
    });

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return index();
    if (pathname === "/api/components") {
      return Response.json(
        store.all().map((e) => ({
          slug: e.slug,
          name: e.name,
          note: e.note,
          url: new URL(`/c/${e.slug}`, req.url).href,
          examples: (e.examples ?? []).map((x) => x.name),
        })),
      );
    }
    if (pathname === "/events") {
      let self: ReadableStreamDefaultController;
      return new Response(
        new ReadableStream({
          start: (c) => void listeners.add((self = c)),
          cancel: () => void listeners.delete(self),
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    }
    const c = pathname.match(/^\/c\/([a-z0-9-]+)$/);
    if (c) return page(c[1]!);
    const o = pathname.match(/^\/out\/([a-z0-9-]+)\/([^/]+)$/);
    const file = o && builds.get(o[1]!)?.files.get(o[2]!);
    if (file) return new Response(file, { headers: { "cache-control": "no-store" } });
    return new Response("not found", { status: 404 });
  }

  // 4777 unless asked otherwise; when it's taken (another playground), any free port.
  let server: ReturnType<typeof serve>;
  try {
    server = serve(opts.port ?? 4777);
  } catch (err) {
    if (opts.port !== undefined) {
      watcher.close();
      throw err;
    }
    server = serve(0);
  }

  return {
    url: server.url.href,
    stop() {
      watcher.close();
      clearTimeout(timer);
      for (const c of listeners) c.close();
      styles.stop();
      server.stop(true);
    },
  };
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
