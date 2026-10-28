import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../src/mcp.ts";

let dir: string;
let client: Client;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-"));
  cpSync(join(import.meta.dir, "fixtures", "app"), dir, { recursive: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server(dir).connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), error: !!r.isError };
}

test("the tools mirror the commands", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["add", "check", "edit", "list", "remove", "scan", "search", "show"]);
  expect(client.getInstructions()).toContain("show to read a component's code");
});

test("an agent can register, find, read and check a component", async () => {
  expect((await call("scan")).text).toContain("src/settings/SettingsDialog.tsx#SettingsDialog");

  const added = await call("add", {
    root: "src/settings/SettingsDialog.tsx#SettingsDialog",
    name: "Settings dialog",
    note: "The preferences modal, with its toggles",
    tags: ["settings", "modal"],
    aliases: ["prefs, the modal"],
  });
  expect(added.error).toBe(false);
  expect(added.text).toContain("settings-dialog — Settings dialog");

  expect((await call("search", { query: "prefs" })).text).toContain("settings-dialog");
  const shown = await call("show", { slugs: ["settings-dialog"] });
  expect(shown.text).toContain("── src/settings/SettingsDialog.tsx");
  expect(shown.text).toContain("export function SettingsDialog");

  const data = JSON.parse((await call("show", { slugs: ["settings-dialog"], code: false, json: true })).text);
  expect(data.aliases).toEqual(["prefs, the modal"]);
  expect(data.files[0].text).toBeUndefined();

  const checked = JSON.parse((await call("check", { json: true })).text);
  expect(checked.components).toEqual([expect.objectContaining({ slug: "settings-dialog", status: "ok" })]);

  await call("edit", { slug: "settings-dialog", unalias: ["prefs, the modal"], alias: ["preferences"] });
  expect((await call("list")).text).toBe("settings-dialog — The preferences modal, with its toggles");
  expect(JSON.parse((await call("list", { json: true })).text)[0].aliases).toEqual(["preferences"]);
  expect((await call("remove", { slugs: ["settings-dialog"] })).text).toBe("removed settings-dialog");
});

test("failures come back as tool errors with the command's message", async () => {
  await call("add", { root: "src/components/Card.tsx", slug: "card" });
  const r = await call("show", { slugs: ["crad"] });
  expect(r).toEqual({ error: true, text: "no component named crad; did you mean card?" });
  expect((await call("add", { root: "nope.tsx" })).error).toBe(true);
});
