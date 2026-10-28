import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, Prop, RootRef, Slice, SliceOptions, Workspace } from "../types.ts";
import type { GoWorkspace } from "./go/workspace.ts";

/** Several adapters over one project, each answering for the files in its language. */
export class CompositeWorkspace implements Workspace {
  constructor(
    readonly root: string,
    private readonly parts: { owns: (file: string) => boolean; ws: Workspace }[],
    /** Adds what crosses between languages to a slice, such as the Go methods a Wails frontend calls. */
    private readonly link?: (slice: Slice, opts: SliceOptions) => Slice,
  ) {}

  private of(file: string): Workspace | undefined {
    return this.parts.find((p) => p.owns(file))?.ws;
  }

  discover(): Candidate[] {
    return this.parts.flatMap((p) => p.ws.discover()).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  slice(root: RootRef, opts: SliceOptions): Slice | undefined {
    const slice = this.of(root.file)?.slice(root, opts);
    return slice && this.link ? this.link(slice, opts) : slice;
  }

  usedBy(root: RootRef): string[] {
    return this.of(root.file)?.usedBy(root) ?? [];
  }

  rootShape(root: RootRef): { shape: string; rootText: string } | undefined {
    return this.of(root.file)?.rootShape(root);
  }

  props(root: RootRef): Prop[] | undefined {
    return this.of(root.file)?.props?.(root);
  }
}

/** The frontend folder of a Wails app, or undefined when the project isn't one. */
export function wailsFrontend(root: string): string | undefined {
  const path = join(root, "wails.json");
  if (!existsSync(path)) return undefined;
  try {
    return (JSON.parse(readFileSync(path, "utf8"))["frontend:dir"] as string | undefined) ?? "frontend";
  } catch {
    return "frontend";
  }
}

const IMPORT = /import\s*(?:\*\s*as\s+([\w$]+)|\{([^}]*)\})\s*from\s*["']([^"']+)["']/g;
/** Wails generates wailsjs/go/<package>/<Struct>.js, one function per bound method. */
const BINDING = /(?:^|\/)wailsjs\/go\/([\w-]+)\/([\w$]+?)(?:\.js)?$/;

/**
 * A Wails frontend component calls Go through generated bindings, so the Go methods it calls (and what only they
 * reach) join its slice: editing the Go side of a component shows up as a change to it.
 */
export function linkWails(go: GoWorkspace): (slice: Slice, opts: SliceOptions) => Slice {
  return (slice, opts) => {
    const methods: RootRef[] = [];
    for (const c of slice.chunks) {
      if (c.kind !== "code" || !c.text || !/\.[cm]?[jt]sx?$/.test(c.file)) continue;
      for (const m of c.text.matchAll(IMPORT)) {
        const b = m[3]!.match(BINDING);
        if (!b) continue;
        const names = m[1]
          ? [...c.text.matchAll(new RegExp(`\\b${m[1].replace(/\$/g, "\\$")}\\.([\\w$]+)`, "g"))].map((x) => x[1]!)
          : m[2]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, "").trim());
        for (const name of names) {
          const ref = name && go.bound(b[1]!, b[2]!, name);
          if (ref && !methods.some((x) => x.symbol === ref.symbol && x.file === ref.file)) methods.push(ref);
        }
      }
    }
    if (methods.length === 0) return slice;
    const traced = go.trace(methods, { boundaries: opts.boundaries, pins: [] });
    const have = new Set(slice.chunks.map((c) => c.file));
    return {
      ...slice,
      chunks: [...slice.chunks, ...traced.chunks.filter((c) => !have.has(c.file))],
      uses: [...slice.uses, ...traced.uses.filter((u) => !slice.uses.some((x) => x.file === u.file && x.symbol === u.symbol))],
      shared: [...new Set([...slice.shared, ...traced.shared])].sort(),
    };
  };
}
