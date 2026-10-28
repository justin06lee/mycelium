import type { Subprocess } from "bun";

/**
 * The worker: plain JavaScript, run by `bun -e` from the project directory. It picks the project's pipeline once,
 * its PostCSS config (Tailwind, autoprefixer and the rest) or else Tailwind v4's own compiler for projects that wire
 * it through Vite, and then answers { id, css, from } messages with the processed stylesheet.
 */
const WORKER = String.raw`
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const root = process.env.MYC_ROOT;

const resolveIn = (name, dirs) => {
  for (const dir of dirs) {
    try {
      return Bun.resolveSync(name, dir);
    } catch {}
  }
};
const load = async (name, dirs) => {
  const file = resolveIn(name, dirs);
  if (!file) throw new Error("can't find " + name + " in the project's node_modules");
  const mod = await import(file);
  return mod.default ?? mod;
};

const POSTCSS = ["postcss.config.mjs", "postcss.config.js", "postcss.config.cjs", "postcss.config.ts", ".postcssrc.json", ".postcssrc"];
const TAILWIND_V3 = ["tailwind.config.ts", "tailwind.config.js", "tailwind.config.mjs", "tailwind.config.cjs"];
const TAILWIND = /@(?:import\s+["']tailwindcss|tailwind\b|apply\b|theme\b|reference\b|plugin\b|source\b|utility\b|variant\b|custom-variant\b)/;
const first = (names) => names.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));

async function postcssPipeline() {
  const file = first(POSTCSS);
  if (!file) return undefined;
  let config = /\.postcssrc(\.json)?$/.test(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : await import(file).then((m) => m.default ?? m);
  if (typeof config === "function") config = config({ env: "development", cwd: root });
  const entries = Array.isArray(config?.plugins) ? config.plugins.map((p) => [p, undefined]) : Object.entries(config?.plugins ?? {});
  const plugins = [];
  const dirs = [root];
  for (const [plugin, opts] of entries) {
    if (opts === false) continue;
    if (typeof plugin !== "string") {
      plugins.push(plugin);
      continue;
    }
    const options = { ...(opts && typeof opts === "object" ? opts : {}) };
    // Both Tailwinds find the project from the working directory unless told.
    if (plugin === "@tailwindcss/postcss") options.base ??= root;
    if (plugin === "tailwindcss") options.config ??= first(TAILWIND_V3);
    plugins.push((await load(plugin, [root]))(options));
    dirs.push(path.dirname(resolveIn(plugin, [root])));
  }
  const postcss = await load("postcss", dirs);
  return async (css, from) => (await postcss(plugins).process(css, { from })).css;
}

async function tailwindPipeline() {
  const dirs = [root];
  const vite = resolveIn("@tailwindcss/vite", dirs);
  if (vite) dirs.push(path.dirname(vite));
  const nodePath = resolveIn("@tailwindcss/node", dirs);
  if (!nodePath) return undefined;
  const node = await import(nodePath);
  const oxide = await load("@tailwindcss/oxide", [...dirs, path.dirname(nodePath)]);
  return async (css, from) => {
    if (!TAILWIND.test(css)) return css;
    const compiler = await node.compile(css, { base: path.dirname(from), from, onDependency: () => {} });
    const roots = compiler.root === "none" ? [] : compiler.root === null ? [{ base: root, pattern: "**/*", negated: false }] : [{ ...compiler.root, negated: false }];
    return compiler.build(new oxide.Scanner({ sources: roots.concat(compiler.sources) }).scan());
  };
}

const ready = (async () => (await postcssPipeline()) ?? (await tailwindPipeline()))();
process.on("message", async ({ id, css, from }) => {
  try {
    const run = await ready;
    process.send({ id, css: run ? await run(css, from) : null });
  } catch (err) {
    process.send({ id, error: String((err && err.stack) || err) });
  }
});
process.on("disconnect", () => process.exit(0));
`;

interface Reply {
  id: number;
  css?: string | null;
  error?: string;
}

/**
 * The project's own stylesheet pipeline, in a worker process. Compiled myc binaries can't resolve a project's
 * node_modules at runtime; with BUN_BE_BUN the same executable runs as plain bun, which can.
 */
export class Styles {
  private proc?: Subprocess;
  private next = 0;
  private readonly pending = new Map<number, { resolve: (css: string | undefined) => void; reject: (err: Error) => void }>();

  constructor(readonly root: string) {}

  /** The stylesheet run through the project's pipeline, or undefined when the project has none. */
  process(css: string, from: string): Promise<string | undefined> {
    const proc = (this.proc ??= this.start());
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.send({ id, css, from });
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
  }

  private start(): Subprocess {
    return Bun.spawn([process.execPath, "-e", WORKER], {
      cwd: this.root,
      env: { ...process.env, BUN_BE_BUN: "1", MYC_ROOT: this.root },
      // Nothing on stdout: under `myc mcp` that's the protocol stream.
      stdio: ["ignore", "ignore", "inherit"],
      ipc: (reply: Reply) => {
        const p = this.pending.get(reply.id);
        if (!p) return;
        this.pending.delete(reply.id);
        if (reply.error) p.reject(new Error(reply.error));
        else p.resolve(reply.css ?? undefined);
      },
      onExit: () => {
        for (const p of this.pending.values()) p.reject(new Error("the stylesheet worker stopped"));
        this.pending.clear();
        this.proc = undefined;
      },
    });
  }
}
