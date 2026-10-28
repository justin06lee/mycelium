import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../src/cli.ts";
import { type Playground, play } from "../src/play.ts";

let dir: string;
let p: Playground | undefined;

function use(fixture?: string) {
  dir = mkdtempSync(join(tmpdir(), "myc-swift-"));
  if (fixture) cpSync(join(import.meta.dir, "fixtures", fixture), dir, { recursive: true });
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
  writeFileSync(join(dir, file), change(readFileSync(join(dir, file), "utf8")));
}

function write(file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const statusOf = (slug: string) => json("check").data.components.find((c: { slug: string }) => c.slug === slug);
const files = (shown: any): string[] => shown.files.map((f: { file: string }) => f.file);
const fileText = (shown: any, file: string): string => shown.files.find((f: { file: string }) => f.file === file)?.text ?? "";

afterEach(() => {
  p?.stop();
  p = undefined;
  rmSync(dir, { recursive: true, force: true });
});

test("scan finds SwiftUI views; what the app's scene shows is a screen; private views are internal; tests are skipped", () => {
  use("swift");
  const found = json("scan").data;
  expect(found.map((c: { symbol: string }) => c.symbol)).toEqual(["NoteList", "NoteRow", "Freshness"]);
  expect(found[0]).toMatchObject({ kind: "screen", suggested: "note-list" });
  const all = json("scan", "--all").data;
  expect(all.find((c: { symbol: string }) => c.symbol === "EmptyState")).toMatchObject({ exported: false });
});

test("a view comes with its extensions, private helpers and its own previews; shared models are linked", () => {
  use("swift");
  expect(myc("add", "Sources/Notes/NoteRow.swift", "--note", "one note").code).toBe(0);
  const row = json("show", "note-row").data;
  expect(files(row)).toEqual(["Sources/Notes/NoteRow.swift", "Sources/Notes/Previews.swift"]);
  expect(fileText(row, "Sources/Notes/NoteRow.swift")).toContain("private func relative");
  expect(fileText(row, "Sources/Notes/NoteRow.swift")).toContain("extension NoteRow");
  const previews = fileText(row, "Sources/Notes/Previews.swift");
  expect(previews).toContain('#Preview("Row")');
  expect(previews).not.toContain('#Preview("List")');
  expect(row.shared).toEqual(["Sources/Notes/Note.swift#Note"]);
  // Previews, like tests, don't make a file a user of the view.
  expect(row.usedBy).toEqual([{ file: "Sources/Notes/NoteList.swift" }]);

  myc("add", "Sources/Notes/NoteList.swift#NoteList");
  const list = json("show", "note-list").data;
  expect(list.uses).toEqual(["note-row"]);
  expect(files(list)).toEqual(["Sources/Notes/NoteList.swift", "Sources/Notes/Previews.swift", "Sources/Notes/Styles.swift"]);
  expect(fileText(list, "Sources/Notes/NoteList.swift")).toContain("private struct EmptyState");
  // .freshness() reaches the View extension, and through it the modifier it applies.
  expect(fileText(list, "Sources/Notes/Styles.swift")).toContain("struct Freshness");
  expect(json("show", "note-row").data.usedBy).toEqual([{ file: "Sources/Notes/NoteList.swift", slug: "note-list" }]);
});

test("edits count where they land, previews included; renames are followed", () => {
  use("swift");
  myc("add", "Sources/Notes/NoteRow.swift");
  rewrite("Sources/Notes/Previews.swift", (t) => t.replace("NoteList()", "NoteList().padding()"));
  expect(statusOf("note-row").status).toBe("ok");
  rewrite("Sources/Notes/Previews.swift", (t) => t.replace("Note.samples[0]", "Note.samples[1]"));
  expect(statusOf("note-row")).toMatchObject({ status: "changed", drift: { changed: ["Sources/Notes/Previews.swift"] } });
  rewrite("Sources/Notes/NoteRow.swift", (t) => t.replace(".named", ".numeric"));
  expect(statusOf("note-row").drift.changed).toEqual(["Sources/Notes/NoteRow.swift", "Sources/Notes/Previews.swift"]);
  myc("check", "--update");

  for (const f of ["Sources/Notes/NoteRow.swift", "Sources/Notes/NoteList.swift", "Sources/Notes/Previews.swift"]) {
    rewrite(f, (t) => t.replaceAll("NoteRow", "NoteCell"));
  }
  expect(json("check", "--update").data.components[0]).toMatchObject({
    status: "relinked",
    relink: { how: "renamed", from: { symbol: "NoteRow" } },
  });
  expect(json("show", "note-row").data.root).toMatchObject({ file: "Sources/Notes/NoteRow.swift", symbol: "NoteCell" });
});

test("an Xcode app beside a TypeScript one: both adapters, modules per target, test targets skipped", () => {
  use();
  write("package.json", "{}");
  write("src/Button.tsx", "export function Button() {\n  return <button>ok</button>;\n}\n");
  mkdirSync(join(dir, "ios/Demo.xcodeproj"), { recursive: true });
  write("ios/Demo.xcodeproj/project.pbxproj", "");
  write("ios/Demo/ContentView.swift", "import SwiftUI\n\nstruct ContentView: View {\n    var body: some View { Badge() }\n}\n");
  write("ios/Demo/Badge.swift", "import SwiftUI\n\nstruct Badge: View {\n    var body: some View { Text(\"1\") }\n}\n");
  write("ios/DemoTests/DemoTests.swift", "import SwiftUI\n\nstruct Fake: View {\n    var body: some View { Badge() }\n}\n");
  const found = json("scan").data.map((c: { file: string; symbol: string }) => `${c.file}#${c.symbol}`);
  expect(found).toEqual(["ios/Demo/Badge.swift#Badge", "ios/Demo/ContentView.swift#ContentView", "src/Button.tsx#Button"]);
  myc("add", "ios/Demo/ContentView.swift");
  expect(files(json("show", "content-view").data)).toEqual(["ios/Demo/ContentView.swift", "ios/Demo/Badge.swift"]);
});

test("the playground says SwiftUI renders in Xcode", async () => {
  use("swift");
  myc("add", "Sources/Notes/NoteRow.swift");
  p = play(dir, { port: 0 });
  expect(await (await fetch(`${p.url}c/note-row`)).text()).toContain("renders in Xcode");
});
