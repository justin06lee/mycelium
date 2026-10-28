import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { run } from "./cli.ts";
import type { Playground } from "./play.ts";
import { findRoot, Store } from "./store.ts";

const INSTRUCTIONS = `mycelium keeps a library of a project's UI components: each one has a slug, a name, a note and a root declaration (file#Symbol). The files it spans, the files it shares with other code and the components it renders are traced from the code on every call, so they are never stale.
Start with list to see what exists, or search for what you need, then show to read a component's code from every file it spans, instead of searching the codebase. Use scan to find components that aren't registered yet and add to register one. After editing code, check finds every component again and reports what changed, moved or is gone; check with update records the new state.
play serves every component rendered live from the code, with its examples (named prop sets set through add or edit), and returns their URLs to open in a browser.
Every tool takes dir, the project directory; it defaults to the directory the server was started in.`;

const dir = z.string().optional().describe("Project directory; defaults to where the server was started");
const json = z.boolean().optional().describe("Return the result as JSON instead of text");
const list = (what: string) => z.array(z.string()).optional().describe(what);
const examples = (what: string) =>
  z
    .array(z.object({ name: z.string(), props: z.record(z.string(), z.unknown()).optional() }))
    .optional()
    .describe(what);
const exampleFlags = (xs?: { name: string; props?: Record<string, unknown> }[]) => xs?.map((x) => `${x.name}=${JSON.stringify(x.props ?? {})}`);

type Args = { dir?: string; json?: boolean };

/** The MCP server: each tool runs the matching myc command, so both stay one implementation. */
export function server(cwd: string): McpServer {
  const mcp = new McpServer({ name: "mycelium", version: pkg.version }, { instructions: INSTRUCTIONS });
  // Playgrounds started by the play tool, one per project, stopped when the client goes away.
  const playgrounds = new Map<string, Playground>();
  const closed = mcp.server.onclose;
  mcp.server.onclose = () => {
    closed?.();
    for (const p of playgrounds.values()) p.stop();
    playgrounds.clear();
  };

  const call = (a: Args, command: string, flags: [string, string | boolean | string[] | undefined][], pos: string[] = []): CallToolResult => {
    const argv = ["-C", a.dir ?? cwd, command];
    for (const [name, value] of flags) {
      if (value === undefined || value === false) continue;
      if (value === true) argv.push(`--${name}`);
      else for (const v of Array.isArray(value) ? value : [value]) argv.push(`--${name}=${v}`);
    }
    let text = "";
    let error = "";
    run([...argv, "--", ...pos], {
      out: (t) => (text += t),
      err: (t) => (error += t.replace(/^myc: /, "")),
      result: (data, t) => (text = a.json ? JSON.stringify(data, null, 2) : t),
    });
    if (error) return { content: [{ type: "text", text: error }], isError: true };
    return { content: [{ type: "text", text }] };
  };

  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  mcp.registerTool(
    "list",
    { description: "The catalog: one line per registered component, with its slug, name and note.", inputSchema: { dir, json }, annotations: read },
    (a) => call(a, "list", []),
  );
  mcp.registerTool(
    "search",
    {
      description: "Find registered components by name, alias, note, tag, symbol or path. Best matches first.",
      inputSchema: { query: z.string().describe("Words to look for, e.g. 'settings toggle'"), dir, json },
      annotations: read,
    },
    (a) => call(a, "search", [], [a.query]),
  );
  mcp.registerTool(
    "show",
    {
      description:
        "Components in full: their root, the files and line ranges they span, what they share, the components they render, what uses them, and their code from every file, root first.",
      inputSchema: {
        slugs: z.array(z.string()).min(1).describe("Slugs to show"),
        code: z.boolean().optional().describe("Include the code; defaults to true"),
        dir,
        json,
      },
      annotations: read,
    },
    (a) => call(a, "show", [["no-code", a.code === false]], a.slugs),
  );
  mcp.registerTool(
    "scan",
    {
      description: "Components in the code that aren't registered yet, each with a suggested slug.",
      inputSchema: { all: z.boolean().optional().describe("Include components that aren't exported"), dir, json },
      annotations: read,
    },
    (a) => call(a, "scan", [["all", a.all]]),
  );
  mcp.registerTool(
    "add",
    {
      description:
        "Register a component by its root declaration. Only the root is stored; its files are traced from the code. Give it a name a person would use and a one-line note.",
      inputSchema: {
        root: z.string().describe("file or file#Symbol, from the project root"),
        slug: z.string().optional().describe("Lowercase words joined by dashes; suggested from the code when left out"),
        name: z.string().optional(),
        note: z.string().optional().describe("One line on what it is"),
        tags: list("Tags"),
        aliases: list("Other names people use for it"),
        pins: list("Files to attach by hand that tracing can't see, such as global CSS"),
        examples: examples("Named prop sets to render it with in play, e.g. [{name: 'empty', props: {items: []}}]"),
        dir,
        json,
      },
      annotations: write,
    },
    (a) =>
      call(
        a,
        "add",
        [
          ["root", a.root],
          ["name", a.name],
          ["note", a.note],
          ["tags", a.tags?.join(",")],
          ["alias", a.aliases],
          ["pin", a.pins],
          ["example", exampleFlags(a.examples)],
        ],
        a.slug ? [a.slug] : [],
      ),
  );
  mcp.registerTool(
    "edit",
    {
      description: "Change a registered component: its name, note, tags or aliases, its root, its pinned files or its examples.",
      inputSchema: {
        slug: z.string(),
        name: z.string().optional(),
        note: z.string().optional(),
        tags: list("Replaces the tags"),
        alias: list("Aliases to add"),
        unalias: list("Aliases to remove"),
        root: z.string().optional().describe("New root, file or file#Symbol"),
        pin: list("Files to pin"),
        unpin: list("Files to unpin"),
        examples: examples("Examples to add, replacing any of the same name"),
        unexample: list("Names of examples to remove"),
        dir,
        json,
      },
      annotations: write,
    },
    (a) =>
      call(
        a,
        "edit",
        [
          ["name", a.name],
          ["note", a.note],
          ["tags", a.tags?.join(",")],
          ["alias", a.alias],
          ["unalias", a.unalias],
          ["root", a.root],
          ["pin", a.pin],
          ["unpin", a.unpin],
          ["example", exampleFlags(a.examples)],
          ["unexample", a.unexample],
        ],
        [a.slug],
      ),
  );
  mcp.registerTool(
    "check",
    {
      description:
        "Find every registered component again after code changes: ok, changed (which files), relinked (moved or renamed, and from where) or orphaned. With update, records the current state.",
      inputSchema: { update: z.boolean().optional().describe("Record changed and relinked components"), dir, json },
      annotations: write,
    },
    (a) => call(a, "check", [["update", a.update]]),
  );
  mcp.registerTool(
    "remove",
    {
      description: "Unregister components. The code is untouched.",
      inputSchema: { slugs: z.array(z.string()).min(1), dir, json },
      annotations: { ...write, destructiveHint: true },
    },
    (a) => call(a, "remove", [], a.slugs),
  );
  mcp.registerTool(
    "play",
    {
      description:
        "Serve every registered component rendered live from the code, each with its examples, and return the URLs. The pages rebuild on every load and reload themselves when the code changes. It keeps running until the client disconnects.",
      inputSchema: { port: z.number().int().optional().describe("Defaults to 4777, or any free port when that's taken"), dir, json },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a): Promise<CallToolResult> => {
      const root = findRoot(a.dir ?? cwd);
      try {
        let p = playgrounds.get(root);
        if (!p) {
          const { play } = await import("./play.ts");
          playgrounds.set(root, (p = play(root, { port: a.port })));
        }
        const components = new Store(root).all().map((e) => ({ slug: e.slug, url: `${p.url}c/${e.slug}` }));
        const text = [`${p.url}  every component, side by side`, ...components.map((c) => `${c.url}  ${c.slug}`)].join("\n");
        return { content: [{ type: "text", text: a.json ? JSON.stringify({ url: p.url, components }, null, 2) : text }] };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    },
  );
  return mcp;
}

export async function serve(cwd: string): Promise<void> {
  const mcp = server(cwd);
  await mcp.connect(new StdioServerTransport());
  // The transport doesn't notice its client hanging up, and a running playground would keep the process alive.
  process.stdin.once("end", () => void mcp.close());
}
