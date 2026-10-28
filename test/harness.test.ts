import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { type Io, run } from "../src/cli.ts";
import { Workspaces } from "../src/workspaces.ts";

let dir: string;
let workspaces: Workspaces;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "myc-harness-")));
  cpSync(join(import.meta.dir, "fixtures", "app"), dir, { recursive: true });
  workspaces = new Workspaces();
});

afterEach(() => {
  workspaces.close();
  rmSync(dir, { recursive: true, force: true });
});

function myc(io: Partial<Io>, ...args: string[]) {
  const out: string[] = [];
  const code = run(["-C", dir, ...args], { out: (t) => out.push(t), err: (t) => out.push(t), ...io });
  return { code, out: out.join("\n") };
}

const json = (...args: string[]) => JSON.parse(myc({}, ...args, "--json").out);

async function until(test: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (test()) return true;
  return test();
}

test("add --all registers everything scan lists, under its suggested slugs", () => {
  const scanned = json("scan").map((c: { suggested: string }) => c.suggested);
  const added = json("add", "--all", "--tags", "ui");
  expect(added.map((e: { slug: string }) => e.slug)).toEqual(scanned);
  expect(added.every((e: { status: string; tags: string[] }) => e.status === "ok" && e.tags[0] === "ui")).toBe(true);
  expect(json("list").map((e: { slug: string }) => e.slug).sort()).toEqual([...scanned].sort());
  expect(myc({}, "add", "--all").out).toBe("every exported component is already registered");
  expect(myc({}, "add", "--all", "src/components/Card.tsx").code).toBe(2);
  expect(myc({}, "add", "--all", "--note", "x").code).toBe(2);
});

test("--version prints the version", () => {
  expect(myc({}, "--version").out).toBe(pkg.version);
});

test("a kept workspace is reused until the code changes, and the next call sees the change", async () => {
  const io = { workspace: (root: string) => workspaces.get(root) };
  myc(io, "add", "src/components/Card.tsx");
  const first = workspaces.get(dir);
  expect(workspaces.get(dir)).toBe(first);

  // mycelium's own files aren't code: registering doesn't drop the analysis.
  myc(io, "edit", "card", "--note", "a card");
  mkdirSync(join(dir, ".mycelium", "examples"), { recursive: true });
  writeFileSync(join(dir, ".mycelium", "examples", "card.tsx"), "export const A = () => null;\n");
  await Bun.sleep(150);
  expect(workspaces.get(dir)).toBe(first);

  const card = join(dir, "src/components/Card.tsx");
  writeFileSync(card, readFileSync(card, "utf8").replace("<h2>{title}</h2>", "<h3>{title}</h3>"));
  expect(await until(() => workspaces.get(dir) !== first)).toBe(true);
  const r = JSON.parse(myc(io, "check", "--json").out);
  expect(r.components[0]).toMatchObject({ slug: "card", status: "changed" });
});
