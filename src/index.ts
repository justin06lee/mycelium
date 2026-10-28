import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTsWorkspace, TsWorkspace } from "./adapters/ts/workspace.ts";
import type { Workspace } from "./types.ts";

export { isTsWorkspace, TsWorkspace } from "./adapters/ts/workspace.ts";
export { type Relink, type Resolved, type Status, Library } from "./engine.ts";
export { type Drift, drift, fingerprint, hash, similarity } from "./fingerprint.ts";
export { search, words } from "./search.ts";
export { findRoot, Store } from "./store.ts";
export type * from "./types.ts";

/** The adapter for whatever language the project at `root` is written in. */
export function openWorkspace(root: string): Workspace {
  if (!isTsWorkspace(root) && existsSync(join(root, "Package.swift"))) {
    throw new Error("Swift projects aren't supported yet: only the TypeScript adapter exists so far");
  }
  return new TsWorkspace(root);
}
