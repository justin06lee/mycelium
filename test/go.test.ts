import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { type Playground, play } from "../src/play.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

let dir: string;
let p: Playground | undefined;

function use(fixture: string) {
  dir = mkdtempSync(join(tmpdir(), "myc-go-"));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
}

function myc(...args: string[]) {
  const out: string[] = [];
  const code = run(["-C", dir, ...args], { out: (t) => out.push(t), err: (t) => out.push(t) });
  return { code, out: out.join("\n") };
}

function json(...args: string[]): { code: number; data: any } {
  const r = myc(...args, "--json");
  return { code: r.code, data: JSON.parse(r.out) };
}

function rewrite(file: string, change: (text: string) => string) {
  const path = join(dir, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
}

const statusOf = (slug: string) => json("check").data.components.find((c: { slug: string }) => c.slug === slug);
const fileText = (shown: any, file: string): string => shown.files.find((f: { file: string }) => f.file === file)?.text ?? "";

afterEach(() => {
  p?.stop();
  p = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("bubble tea", () => {
  test("scan finds models, sub-models and the functions that draw views", () => {
    use("tui");
    const found = json("scan").data;
    expect(found.map((c: { symbol: string }) => c.symbol)).toEqual(["Model.header", "badge", "footer", "list", "list.row", "Model"]);
    const model = found.find((c: { symbol: string }) => c.symbol === "Model");
    expect(model.kind).toBe("screen");
    expect(model.suggested).toBe("ui-model");
    expect(found.find((c: { symbol: string }) => c.symbol === "Model.header").suggested).toBe("header");
  });

  test("a type comes with its methods and what only it reaches; shared styles are linked", () => {
    use("tui");
    expect(myc("add", "internal/ui/list.go#list", "--note", "message list").code).toBe(0);
    const s = json("show", "list").data;
    expect(s.files.map((f: { file: string }) => f.file)).toEqual(["internal/ui/list.go", "internal/ui/styles.go"]);
    const list = fileText(s, "internal/ui/list.go");
    expect(list).toContain("func (l list) move");
    expect(list).toContain("func clamp");
    expect(list).toContain("func (i item) label");
    expect(list).not.toContain("func newList");
    const styles = fileText(s, "internal/ui/styles.go");
    expect(styles).toContain("styleSelected");
    expect(styles).not.toContain("styleMuted");
    // newList builds items too, so the item type is shared; its label method only the list calls.
    expect(s.shared).toEqual(["internal/ui/list.go#item"]);
    expect(list).not.toContain("type item struct");
    expect(s.usedBy.map((u: { file: string }) => u.file)).toEqual(["internal/ui/list.go", "internal/ui/model.go"]);
  });

  test("registered views and sub-models are boundaries the model uses", () => {
    use("tui");
    myc("add", "internal/ui/list.go#list");
    myc("add", "internal/ui/header.go#Model.header");
    myc("add", "internal/ui/model.go#Model");
    const model = json("show", "ui-model").data;
    expect(model.uses.sort()).toEqual(["header", "list"]);
    expect(fileText(model, "internal/ui/header.go")).toContain("func footer");
    expect(fileText(model, "internal/ui/header.go")).not.toContain("func badge");
    expect(model.shared).toContain("internal/ui/styles.go#styleMuted");

    const header = json("show", "header").data;
    expect(header.files.map((f: { file: string }) => f.file)).toEqual(["internal/ui/header.go", "internal/ui/styles.go"]);
    expect(fileText(header, "internal/ui/header.go")).toContain("func badge");
    expect(fileText(header, "internal/ui/styles.go")).toContain("styleTitle");
    expect(header.shared).toEqual(["internal/ui/styles.go#styleMuted"]);
    expect(header.usedBy).toEqual([{ file: "internal/ui/model.go", slug: "ui-model" }]);
  });

  test("edits count where they land: a private style changes the list, a shared one doesn't", () => {
    use("tui");
    myc("add", "internal/ui/list.go#list");
    rewrite("internal/ui/styles.go", (t) => t.replace(`Color("8")`, `Color("7")`));
    expect(statusOf("list").status).toBe("ok");
    rewrite("internal/ui/styles.go", (t) => t.replace(`Color("212")`, `Color("99")`));
    expect(statusOf("list")).toMatchObject({ status: "changed", drift: { changed: ["internal/ui/styles.go"] } });
    myc("check", "--update");
    expect(statusOf("list").status).toBe("ok");
  });

  test("renamed types and moved methods are followed", () => {
    use("tui");
    myc("add", "internal/ui/list.go#list");
    myc("add", "internal/ui/header.go#Model.header");
    for (const f of ["internal/ui/list.go", "internal/ui/model.go"]) rewrite(f, (t) => t.replace(/\blist\b/g, "menu"));
    const header = readFileSync(join(dir, "internal/ui/header.go"), "utf8");
    const method = header.slice(header.indexOf("func (m Model) header"), header.indexOf("func badge"));
    rewrite("internal/ui/header.go", (t) => t.replace(method, ""));
    writeFileSync(join(dir, "internal/ui/title.go"), `package ui\n\n${method}`);

    const rows = json("check", "--update").data.components;
    expect(rows.find((r: { slug: string }) => r.slug === "list")).toMatchObject({
      status: "relinked",
      relink: { how: "renamed", from: { file: "internal/ui/list.go", symbol: "list" } },
    });
    expect(rows.find((r: { slug: string }) => r.slug === "header")).toMatchObject({ status: "relinked", relink: { how: "moved" } });
    expect(json("show", "list").data.root).toMatchObject({ file: "internal/ui/list.go", symbol: "menu" });
    expect(json("show", "header").data.root).toMatchObject({ file: "internal/ui/title.go", symbol: "Model.header" });
  });

  test("the playground says a terminal view can't render in a browser", async () => {
    use("tui");
    myc("add", "internal/ui/list.go#list");
    p = play(dir, { port: 0 });
    const html = await (await fetch(`${p.url}c/list`)).text();
    expect(html).toContain("terminal view written in Go");
  });
});

describe("wails", () => {
  test("frontend components are found, and the Go methods they call join their slice", () => {
    use("wails");
    expect(json("scan").data.map((c: { file: string; symbol: string }) => `${c.file}#${c.symbol}`)).toEqual([
      "frontend/src/App.tsx#App",
      "frontend/src/Logo.tsx#Logo",
    ]);
    // Started inside the frontend, myc still works on the app around it.
    const out: string[] = [];
    expect(run(["-C", join(dir, "frontend/src"), "add", "App.tsx", "--note", "greeting form"], { out: (t) => out.push(t), err: (t) => out.push(t) })).toBe(0);
    expect(existsSync(join(dir, ".mycelium/components/app.json"))).toBe(true);

    const s = json("show", "app").data;
    expect(s.files.map((f: { file: string }) => f.file)).toEqual(["frontend/src/App.tsx", "frontend/src/Logo.tsx", "app.go"]);
    const go = fileText(s, "app.go");
    expect(go).toContain("func (a *App) Greet");
    expect(go).toContain("func greeting");
    expect(go).not.toContain("Version");
    expect(go).not.toContain("NewApp");

    rewrite("app.go", (t) => t.replace('return "1.0.0"', 'return "1.0.1"'));
    expect(statusOf("app").status).toBe("ok");
    rewrite("app.go", (t) => t.replace("it's show time", "welcome"));
    expect(statusOf("app")).toMatchObject({ status: "changed", drift: { changed: ["app.go"] } });
  });

  test("the playground renders a frontend component with the frontend's own React", async () => {
    use("wails");
    const modules = join(dir, "frontend/node_modules");
    mkdirSync(modules, { recursive: true });
    for (const pkg of ["react", "react-dom", "scheduler"]) symlinkSync(join(import.meta.dir, "../node_modules", pkg), join(modules, pkg));
    myc("add", "frontend/src/App.tsx");
    p = play(dir, { port: 0 });
    const html = await (await fetch(`${p.url}c/app`)).text();
    expect(html).toContain('src="/out/app/app.js"');
    const js = await (await fetch(`${p.url}out/app/app.js`)).text();
    expect(js).toContain("Please enter your name below");
    expect(existsSync(join(modules, ".cache/myc-play/app.tsx"))).toBe(true);
    expect(existsSync(join(dir, ".mycelium/play"))).toBe(false);
  });
});
