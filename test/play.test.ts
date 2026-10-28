import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../src/cli.ts";
import { bridges, entrySource, globalCss, type Playground, play, referencedAliases } from "../src/play.ts";
import type { Entry } from "../src/types.ts";

let dir: string;
let p: Playground | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-play-"));
  cpSync(join(import.meta.dir, "fixtures", "app"), dir, { recursive: true });
  // The fixture has no dependencies of its own; React comes from this repo's.
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(dir, "node_modules"));
});

afterEach(() => {
  p?.stop();
  p = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): number {
  return run(["-C", dir, ...args], { out: () => {}, err: (t) => console.error(t) });
}

function write(file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const get = async (path: string) => {
  const r = await fetch(new URL(path, p!.url));
  return { status: r.status, text: await r.text() };
};

test("a component renders from its own code with its examples", async () => {
  expect(myc("add", "card", "src/components/Card.tsx", "--example", 'basic={"title":"Hello from an example"}')).toBe(0);
  p = play(dir, { port: 0 });

  const page = await get("/c/card");
  expect(page.text).toContain('<div id="root"></div>');
  expect(page.text).toContain('src="/out/card/card.js"');

  const js = await get("/out/card/card.js");
  expect(js.status).toBe(200);
  expect(js.text).toContain("Hello from an example");
  expect(js.text).toContain("createRoot");

  const entry = readFileSync(join(dir, ".mycelium/play/card.tsx"), "utf8");
  expect(entry).toContain('import { Card as Component } from "../../src/components/Card.tsx"');
  expect(readFileSync(join(dir, ".mycelium/play/.gitignore"), "utf8")).toBe("*\n");

  const api = JSON.parse((await get("/api/components")).text);
  expect(api).toEqual([expect.objectContaining({ slug: "card", examples: ["basic"], url: `${p.url}c/card` })]);
  expect((await get("/")).text).toContain('<iframe src="/c/card"');
});

test("CSS modules and path aliases bundle, and the stylesheet is linked", async () => {
  myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
  p = play(dir, { port: 0 });
  const page = await get("/c/settings-dialog");
  const css = page.text.match(/href="(\/out\/settings-dialog\/[^"]+\.css)"/)?.[1];
  expect(css).toBeDefined();
  expect((await get(css!)).text).toContain("dialog");
});

test("framework modules are stubbed and example files can pass JSX", async () => {
  write(
    "src/components/NavLink.tsx",
    `import Link from "next/link";
import { usePathname } from "next/navigation";
export function NavLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} data-active={usePathname() === href}>{label}</Link>;
}`,
  );
  myc("add", "nav-link", "src/components/NavLink.tsx");
  write(
    ".mycelium/examples/nav-link.tsx",
    `import { NavLink } from "@/components/NavLink";
export const Home = () => <nav><NavLink href="/" label="Example file home" /></nav>;`,
  );
  p = play(dir, { port: 0 });
  expect((await get("/c/nav-link")).text).not.toContain("myc-error\">");
  const js = (await get("/out/nav-link/nav-link.js")).text;
  expect(js).toContain("Example file home");
  expect(js).not.toContain("next/dist");
});

test("what can't render says why instead of failing", async () => {
  myc("add", "settings-row", "src/settings/SettingsDialog.tsx#Row");
  write("src/components/Broken.tsx", `import { missing } from "./nowhere";\nexport function Broken() { return <p>{missing}</p>; }`);
  myc("add", "broken", "src/components/Broken.tsx");
  p = play(dir, { port: 0 });
  expect((await get("/c/settings-row")).text).toContain("isn't exported");
  expect((await get("/c/broken")).text).toContain("nowhere");
  expect((await get("/c/nope")).text).toContain("no component named nope");
});

test("stylesheets go through the project's own PostCSS config, and global CSS comes from the app's entry", async () => {
  write("postcss.config.mjs", `export default { plugins: { "./brand.mjs": { color: "rebeccapurple" } } };`);
  write(
    "brand.mjs",
    `const brand = (opts) => ({ postcssPlugin: "brand", Declaration(d) { if (d.value === "BRAND") d.value = opts.color; } });
brand.postcss = true;
export default brand;`,
  );
  write("src/app/globals.css", `body { color: BRAND; }`);
  write("src/app/layout.tsx", `import "./globals.css";\nexport default function RootLayout({ children }: { children: unknown }) { return children; }`);
  expect(globalCss(dir)).toEqual(["src/app/globals.css"]);

  myc("add", "card", "src/components/Card.tsx");
  p = play(dir, { port: 0 });
  const page = await get("/c/card");
  const css = page.text.match(/href="(\/out\/card\/[^"]+\.css)"/)?.[1];
  expect((await get(css!)).text).toContain("color: #639");
});

test("async server components are awaited and server actions stay on the server", async () => {
  write(
    "src/app/actions.ts",
    `"use server";
import { readFileSync } from "node:fs";
export async function save(form: FormData) { return readFileSync(String(form.get("path")), "utf8"); }`,
  );
  write(
    "src/app/notes/page.tsx",
    `import { save } from "../actions";
export default async function Notes({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <form action={save}><p>Notes for {q}</p></form>;
}`,
  );
  myc("add", "notes-page", "src/app/notes/page.tsx", "--example", 'search={"searchParams":{"q":"bugs"}}');
  p = play(dir, { port: 0 });
  expect((await get("/c/notes-page")).text).not.toContain('myc-error">');
  const js = (await get("/out/notes-page/notes-page.js")).text;
  expect(js).toContain("save is a server action");
  expect(js).not.toContain("readFileSync");
  expect(readFileSync(join(dir, ".mycelium/play/notes-page.tsx"), "utf8")).toContain("const screen = true;");
});

test("callback props get logging stand-ins, a setup module runs first, and preload bridges are shimmed", async () => {
  write(
    "src/components/Dialog.tsx",
    `export function Dialog({ title, onClose, onSave }: { title: string; onClose: () => void; onSave?: (v: string) => void }) {
  return <div><h3>{title}</h3><button onClick={onClose}>close</button><button onClick={() => onSave?.("x")}>save</button></div>;
}`,
  );
  write(".mycelium/setup.ts", `(window as any).desk = { load: async () => ({ ok: true }) };`);
  write("src/preload/index.ts", `import { contextBridge } from "electron";\ncontextBridge.exposeInMainWorld("desk", {});`);
  expect(bridges(dir)).toContain("desk");
  myc("add", "dialog", "src/components/Dialog.tsx", "--example", 'basic={"title":"Hi"}');
  p = play(dir, { port: 0 });
  const page = (await get("/c/dialog")).text;
  expect(page).toContain('"desk"]');
  const entry = readFileSync(join(dir, ".mycelium/play/dialog.tsx"), "utf8");
  expect(entry).toContain('["onClose","onSave"]');
  expect(entry.indexOf('import "../../.mycelium/setup.ts";')).toBeLessThan(entry.indexOf("import * as React"));
});

test("path aliases come from tsconfigs the root one references", async () => {
  write("tsconfig.json", `{ "files": [], "references": [{ "path": "./tsconfig.web.json" }] }`);
  write(
    "tsconfig.web.json",
    `{ // comments are allowed here
  "compilerOptions": { "jsx": "react-jsx", "baseUrl": ".", "paths": { "~ui/*": ["src/components/*"], "@/*": ["src/*"] } },
}`,
  );
  write("src/components/Shelf.tsx", `import { Card } from "~ui/Card";\nexport function Shelf() { return <Card title="On the shelf" />; }`);
  expect(referencedAliases(dir).map((a) => a.pattern.source)).toEqual(["^~ui\\/(.*)$", "^@\\/(.*)$"]);
  myc("add", "shelf", "src/components/Shelf.tsx");
  p = play(dir, { port: 0 });
  expect((await get("/c/shelf")).text).not.toContain('myc-error">');
  expect((await get("/out/shelf/shelf.js")).text).toContain("On the shelf");
});

test("the entry wraps renders in the configured provider and loads global CSS", () => {
  const entry: Entry = {
    slug: "card",
    name: "Card",
    aliases: [],
    note: "",
    tags: [],
    root: { file: "src/components/Card.tsx", symbol: "Card" },
    pins: [],
    examples: [{ name: "basic", props: { title: "Hi" } }],
    createdAt: "",
    updatedAt: "",
  };
  const source = entrySource(dir, entry, { symbol: "Card", default: false, kind: "component" }, {
    render: { wrapper: "src/Providers.tsx#Providers", css: ["src/app/globals.css"] },
  });
  expect(source).toContain('import { Providers as Wrapper } from "../../src/Providers.tsx";');
  expect(source).toContain('import "../../src/app/globals.css";');
  expect(source).toContain('[{"name":"basic","props":{"title":"Hi"}}]');
  expect(entrySource(dir, entry, { symbol: "Card", default: true, kind: "component" }, {})).toContain(
    'import Component from "../../src/components/Card.tsx";',
  );
});

test("examples are set, replaced and removed through edit", () => {
  myc("add", "card", "src/components/Card.tsx", "--example", 'a={"title":"A"}');
  myc("edit", "card", "--example", 'a={"title":"A2"}', "--example", "b");
  const stored = () => JSON.parse(readFileSync(join(dir, ".mycelium/components/card.json"), "utf8")) as Entry;
  expect(stored().examples).toEqual([
    { name: "a", props: { title: "A2" } },
    { name: "b", props: {} },
  ]);
  myc("edit", "card", "--unexample", "a");
  expect(stored().examples).toEqual([{ name: "b", props: {} }]);
  expect(run(["-C", dir, "edit", "card", "--example", "c={not json"], { out: () => {}, err: () => {} })).toBe(2);
  expect(existsSync(join(dir, ".mycelium/play"))).toBe(false);
});
