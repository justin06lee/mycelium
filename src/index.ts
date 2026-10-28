import { CompositeWorkspace, linkWails, wailsFrontend } from "./adapters/composite.ts";
import { GoWorkspace, isGoWorkspace } from "./adapters/go/workspace.ts";
import { isSwiftWorkspace, SwiftWorkspace } from "./adapters/swift/workspace.ts";
import { isTsWorkspace, TsWorkspace } from "./adapters/ts/workspace.ts";
import type { Workspace } from "./types.ts";

export { CompositeWorkspace, linkWails, wailsFrontend } from "./adapters/composite.ts";
export { GoWorkspace, isGoWorkspace } from "./adapters/go/workspace.ts";
export { isSwiftWorkspace, SwiftWorkspace } from "./adapters/swift/workspace.ts";
export { isTsWorkspace, TsWorkspace } from "./adapters/ts/workspace.ts";
export { type Relink, type Resolved, type Status, Library } from "./engine.ts";
export { type Drift, drift, fingerprint, hash, similarity } from "./fingerprint.ts";
export { entrySource, PLAY_DIR, type Playground, play, readConfig } from "./play.ts";
export { search, words } from "./search.ts";
export { findRoot, Store } from "./store.ts";
export type * from "./types.ts";

/** The adapters for whatever the project at `root` is written in, combined when it mixes languages. */
export function openWorkspace(root: string): Workspace {
  const parts: { owns: (file: string) => boolean; ws: Workspace }[] = [];
  // Wails: Go bound to a web frontend, whose components reach into Go through generated bindings.
  const frontend = wailsFrontend(root);
  const go = frontend !== undefined || isGoWorkspace(root) ? new GoWorkspace(root) : undefined;
  if (go) parts.push({ owns: (f) => f.endsWith(".go"), ws: go });
  if (isSwiftWorkspace(root)) parts.push({ owns: (f) => f.endsWith(".swift"), ws: new SwiftWorkspace(root) });
  if (frontend !== undefined) parts.push({ owns: () => true, ws: new TsWorkspace(root, { dir: frontend }) });
  else if (isTsWorkspace(root) || parts.length === 0) parts.push({ owns: () => true, ws: new TsWorkspace(root) });
  if (parts.length === 1) return parts[0]!.ws;
  return new CompositeWorkspace(root, parts, go && frontend !== undefined ? linkWails(go) : undefined);
}
