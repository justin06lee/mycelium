import { existsSync } from "node:fs";
import { join } from "node:path";
import { CompositeWorkspace, linkWails, wailsFrontend } from "./adapters/composite.ts";
import { GoWorkspace, isGoWorkspace } from "./adapters/go/workspace.ts";
import { isTsWorkspace, TsWorkspace } from "./adapters/ts/workspace.ts";
import type { Workspace } from "./types.ts";

export { CompositeWorkspace, linkWails, wailsFrontend } from "./adapters/composite.ts";
export { GoWorkspace, isGoWorkspace } from "./adapters/go/workspace.ts";
export { isTsWorkspace, TsWorkspace } from "./adapters/ts/workspace.ts";
export { type Relink, type Resolved, type Status, Library } from "./engine.ts";
export { type Drift, drift, fingerprint, hash, similarity } from "./fingerprint.ts";
export { entrySource, PLAY_DIR, type Playground, play, readConfig } from "./play.ts";
export { search, words } from "./search.ts";
export { findRoot, Store } from "./store.ts";
export type * from "./types.ts";

const isGo = (file: string) => file.endsWith(".go");

/** The adapters for whatever the project at `root` is written in, combined when it mixes languages. */
export function openWorkspace(root: string): Workspace {
  // Wails: Go bound to a web frontend, whose components reach into Go through generated bindings.
  const frontend = wailsFrontend(root);
  if (frontend !== undefined) {
    const go = new GoWorkspace(root);
    const ts = new TsWorkspace(root, { dir: frontend });
    return new CompositeWorkspace(root, [{ owns: isGo, ws: go }, { owns: () => true, ws: ts }], linkWails(go));
  }
  const hasTs = isTsWorkspace(root);
  if (isGoWorkspace(root)) {
    const go = new GoWorkspace(root);
    return hasTs ? new CompositeWorkspace(root, [{ owns: isGo, ws: go }, { owns: () => true, ws: new TsWorkspace(root) }]) : go;
  }
  if (!hasTs && existsSync(join(root, "Package.swift"))) {
    throw new Error("Swift projects aren't supported yet: only the TypeScript and Go adapters exist so far");
  }
  return new TsWorkspace(root);
}
