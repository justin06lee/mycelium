import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../src/cli.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

let dir: string;

function use(fixture: string) {
  dir = mkdtempSync(join(tmpdir(), "myc-"));
  cpSync(join(FIXTURES, fixture), dir, { recursive: true });
}

function myc(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["-C", dir, ...args], { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function json(...args: string[]): { code: number; data: any } {
  const r = myc(...args, "--json");
  return { code: r.code, data: JSON.parse(r.out) };
}

function rewrite(file: string, change: (text: string) => string) {
  const path = join(dir, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
}

function write(file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const statusOf = (slug: string) => json("check").data.components.find((c: { slug: string }) => c.slug === slug);

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("next-style app", () => {
  beforeEach(() => use("app"));

  test("scan finds components, pages as screens, and internal ones only with --all", () => {
    const found = json("scan").data.map((c: { symbol: string }) => c.symbol);
    expect(found).toEqual(["Home", "Card", "ToggleSwitch", "SettingsDialog", "SettingsBadge"]);
    const home = json("scan").data.find((c: { symbol: string }) => c.symbol === "Home");
    expect(home.kind).toBe("screen");
    expect(home.suggested).toBe("home-page");
    expect(json("scan", "--all").data.map((c: { symbol: string }) => c.symbol)).toContain("Row");
  });

  test("a slice owns its private files, links shared ones and stops at registered components", () => {
    expect(myc("add", "src/components/ToggleSwitch.tsx").code).toBe(0);
    const added = json("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog", "--note", "preferences modal");
    expect(added.code).toBe(0);

    const s = json("show", "settings-dialog").data;
    expect(s.status).toBe("ok");
    expect(s.files.map((f: { file: string }) => f.file)).toEqual([
      "src/settings/SettingsDialog.tsx",
      "src/settings/SettingsDialog.module.css",
      "src/settings/defaults.ts",
      "src/settings/useSettings.ts",
    ]);
    expect(s.uses).toEqual(["toggle-switch"]);
    expect(s.shared).toContain("src/lib/cn.ts");
    expect(s.usedBy).toEqual([{ file: "src/app/page.tsx" }]);

    // The root file is shared with SettingsBadge, so only the dialog's lines come along.
    const root = s.files[0];
    expect(root.ranges).toEqual([
      [1, 1],
      [3, 24],
    ]);
    expect(root.text).not.toContain("badge");
    expect(root.text).toContain("function Row");
    expect(JSON.stringify(s.files)).not.toContain("badge.module.css");

    // The toggle's own entry now names its user.
    expect(json("show", "toggle-switch").data.usedBy).toEqual([
      { file: "src/settings/SettingsDialog.tsx", slug: "settings-dialog" },
    ]);
  });

  test("without the toggle registered, the dialog owns it: a barrel passing it along doesn't count as using it", () => {
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    const s = json("show", "settings-dialog", "--no-code").data;
    // Only the dialog imports ToggleSwitch (the barrel re-exports it, which doesn't count), so the dialog owns it.
    expect(s.files.map((f: { file: string }) => f.file)).toContain("src/components/ToggleSwitch.tsx");
    expect(s.files.map((f: { file: string }) => f.file)).not.toContain("src/components/Card.tsx");
    expect(s.uses).toEqual([]);
  });

  test("formatting and comments don't count as changes", () => {
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    rewrite("src/settings/SettingsDialog.tsx", (t) =>
      t.replace("export function SettingsDialog() {", "// The main dialog.\nexport function SettingsDialog()   {\n"),
    );
    expect(statusOf("settings-dialog").status).toBe("ok");
    rewrite("src/settings/defaults.ts", (t) => t.replace("motion: false", "motion: true"));
    const c = statusOf("settings-dialog");
    expect(c.status).toBe("changed");
    expect(c.drift.changed).toEqual(["src/settings/defaults.ts"]);
  });

  test("splitting a helper into its own file keeps it in the slice", () => {
    myc("add", "src/components/ToggleSwitch.tsx");
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    rewrite("src/settings/SettingsDialog.tsx", (t) => {
      const start = t.indexOf("function Row");
      const end = t.indexOf("export function SettingsDialog");
      return `import { Row } from "./Row";\n${t.slice(0, start)}${t.slice(end)}`;
    });
    write(
      "src/settings/Row.tsx",
      `import styles from "./SettingsDialog.module.css";
import { ToggleSwitch } from "@/components";

export function Row({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <ToggleSwitch on={on} onChange={onChange} />
    </div>
  );
}
`,
    );
    const c = statusOf("settings-dialog");
    expect(c.status).toBe("changed");
    expect(c.drift.added).toEqual(["src/settings/Row.tsx"]);
    const s = json("show", "settings-dialog", "--no-code").data;
    expect(s.files.map((f: { file: string }) => f.file)).toContain("src/settings/Row.tsx");
    expect(s.uses).toEqual(["toggle-switch"]);

    const updated = json("check", "--update").data.components;
    expect(updated.find((c: { slug: string }) => c.slug === "settings-dialog").recorded).toBe(true);
    expect(statusOf("settings-dialog").status).toBe("ok");
  });

  test("a renamed component is found again by its shape", () => {
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    rewrite("src/settings/SettingsDialog.tsx", (t) => t.replace("function SettingsDialog", "function PreferencesDialog"));
    rewrite("src/app/page.tsx", (t) => t.replaceAll("SettingsDialog", "PreferencesDialog"));
    const c = statusOf("settings-dialog");
    expect(c.status).toBe("relinked");
    expect(c.relink.how).toBe("renamed");

    myc("check", "--update");
    expect(json("show", "settings-dialog").data.root.symbol).toBe("PreferencesDialog");
    expect(statusOf("settings-dialog").status).toBe("ok");
  });

  test("a renamed and edited component is found again by similarity", () => {
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    rewrite("src/settings/SettingsDialog.tsx", (t) =>
      t
        .replace("function SettingsDialog", "function PreferencesDialog")
        .replace('<Row label="Motion"', '<Row label="Haptics" on={values.sound} onChange={() => {}} />\n      <Row label="Motion"'),
    );
    const c = statusOf("settings-dialog");
    expect(c.status).toBe("relinked");
    expect(c.relink.how).toBe("similar");
  });

  test("a moved folder is followed by name", () => {
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    renameSync(join(dir, "src/settings"), join(dir, "src/preferences"));
    rewrite("src/app/page.tsx", (t) => t.replace("@/settings/", "@/preferences/"));
    const c = statusOf("settings-dialog");
    expect(c.status).toBe("relinked");
    expect(c.relink.how).toBe("moved");
    const s = json("show", "settings-dialog", "--no-code").data;
    expect(s.root.file).toBe("src/preferences/SettingsDialog.tsx");
    expect(s.files.map((f: { file: string }) => f.file)).toContain("src/preferences/useSettings.ts");
  });

  test("a deleted component is orphaned and check fails", () => {
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    rmSync(join(dir, "src/settings/SettingsDialog.tsx"));
    rewrite("src/app/page.tsx", (t) =>
      t.replace(/import \{ SettingsDialog \}.*\n/, "").replace("<SettingsDialog />", ""),
    );
    const r = json("check");
    expect(r.code).toBe(1);
    expect(r.data.components[0].status).toBe("orphaned");
  });

  test("any top-level declaration can be a root, not just components", () => {
    expect(myc("add", "use-settings", "src/settings/useSettings.ts#useSettings").code).toBe(0);
    const s = json("show", "use-settings").data;
    expect(s.status).toBe("ok");
    expect(s.files.map((f: { file: string }) => f.file)).toEqual(["src/settings/useSettings.ts", "src/settings/defaults.ts"]);
  });

  test("add explains what it needs", () => {
    const many = myc("add", "src/settings/SettingsDialog.tsx");
    expect(many.code).toBe(2);
    expect(many.err).toContain("src/settings/SettingsDialog.tsx#SettingsBadge");
    expect(myc("add", "Bad_Slug", "src/components/Card.tsx").code).toBe(2);
    expect(myc("add", "card", "src/components/Card.tsx").code).toBe(0);
    expect(myc("add", "card-again", "src/components/Card.tsx").err).toContain("already registered as card");
    expect(myc("add", "card", "src/components/ToggleSwitch.tsx").err).toContain("already registered");
    expect(myc("show", "crad").err).toContain("did you mean card");
  });

  test("list is the catalog and search ranks by name, note and tags", () => {
    myc("add", "settings-dialog", "src/settings/SettingsDialog.tsx#SettingsDialog", "--note", "preferences modal with sound and motion toggles", "--tags", "modal");
    myc("add", "src/components/Card.tsx", "--name", "the content cards", "--note", "titled box around a section");
    myc("add", "src/app/page.tsx");
    expect(myc("list").out.split("\n")).toEqual([
      "card (the content cards) — titled box around a section",
      "home-page — src/app/page.tsx#Home",
      "settings-dialog — preferences modal with sound and motion toggles",
    ]);
    expect(json("search", "motion toggles").data[0].slug).toBe("settings-dialog");
    expect(json("search", "content cards").data[0].slug).toBe("card");
    expect(json("search", "modal").data.map((h: { slug: string }) => h.slug)).toEqual(["settings-dialog"]);
    expect(myc("search", "zebra").code).toBe(1);
  });

  test("edit changes metadata, and a new root starts a new fingerprint", () => {
    myc("add", "dialog", "src/settings/SettingsDialog.tsx#SettingsDialog");
    myc("edit", "dialog", "--note", "the settings modal", "--alias", "prefs", "--tags", "a,b");
    const e = json("show", "dialog", "--no-code").data;
    expect([e.note, e.aliases, e.tags]).toEqual(["the settings modal", ["prefs"], ["a", "b"]]);
    myc("edit", "dialog", "--root", "src/settings/SettingsDialog.tsx#SettingsBadge");
    const moved = json("show", "dialog", "--no-code").data;
    expect(moved.status).toBe("ok");
    expect(moved.files.map((f: { file: string }) => f.file)).toEqual([
      "src/settings/SettingsDialog.tsx",
      "src/settings/badge.module.css",
    ]);
    expect(myc("remove", "dialog").code).toBe(0);
    expect(myc("list").out).toContain("empty");
  });
});

describe("electron-vite layout", () => {
  beforeEach(() => use("electron"));

  test("tsconfig references load the renderer, with its path alias and side-effect CSS", () => {
    expect(json("scan").data.map((c: { symbol: string }) => c.symbol)).toEqual(["App", "Versions"]);
    myc("add", "app", "src/renderer/src/App.tsx");
    const s = json("show", "app", "--no-code").data;
    expect(s.root.symbol).toBe("App");
    expect(s.files.map((f: { file: string }) => f.file)).toEqual([
      "src/renderer/src/App.tsx",
      "src/renderer/src/components/Versions.tsx",
      "src/renderer/src/components/versions.css",
    ]);
  });
});
