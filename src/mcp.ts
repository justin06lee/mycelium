import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { run } from "./cli.ts";

const INSTRUCTIONS = `mycelium keeps a library of a project's UI components: each one has a slug, a name, a note and a root declaration (file#Symbol). The files it spans, the files it shares with other code and the components it renders are traced from the code on every call, so they are never stale.
Start with list to see what exists, or search for what you need, then show to read a component's code from every file it spans, instead of searching the codebase. Use scan to find components that aren't registered yet and add to register one. After editing code, check finds every component again and reports what changed, moved or is gone; check with update records the new state.
Every tool takes dir, the project directory; it defaults to the directory the server was started in.`;

const dir = z.string().optional().describe("Project directory; defaults to where the server was started");
const json = z.boolean().optional().describe("Return the result as JSON instead of text");
const list = (what: string) => z.array(z.string()).optional().describe(what);

type Args = { dir?: string; json?: boolean };

/** The MCP server: each tool runs the matching myc command, so both stay one implementation. */
export function server(cwd: string): McpServer {
  const mcp = new McpServer({ name: "mycelium", version: pkg.version }, { instructions: INSTRUCTIONS });

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
        ],
        a.slug ? [a.slug] : [],
      ),
  );
  mcp.registerTool(
    "edit",
    {
      description: "Change a registered component: its name, note, tags or aliases, its root, or its pinned files.",
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
  return mcp;
}

export async function serve(cwd: string): Promise<void> {
  await server(cwd).connect(new StdioServerTransport());
}
