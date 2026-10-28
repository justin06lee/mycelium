import { type FSWatcher, watch } from "node:fs";
import { openWorkspace } from "./open.ts";
import type { Workspace } from "./types.ts";

/** Changes that aren't to the code: installs, build output, git, and mycelium's own files. */
const IGNORED = /(^|[\\/])(node_modules|\.git|\.next|\.turbo|dist|build|out|target|\.build|DerivedData|\.mycelium)([\\/]|$)/;

/**
 * Each project's code analysis, kept between calls by a long-running process (the MCP server, an embedding
 * harness) and dropped as soon as a file changes. Opening a large project takes seconds; a kept one, nothing.
 */
export class Workspaces {
  private open = new Map<string, { ws?: Workspace; watcher?: FSWatcher }>();

  get(root: string): Workspace {
    let entry = this.open.get(root);
    if (!entry) {
      entry = {};
      const kept = entry;
      try {
        kept.watcher = watch(root, { recursive: true }, (_event, file) => {
          if (!file || !IGNORED.test(file)) kept.ws = undefined;
        });
      } catch {
        // No watching (an unsupported filesystem): nothing is kept, so every call reads the code afresh.
      }
      this.open.set(root, entry);
    }
    if (!entry.watcher) return openWorkspace(root);
    return (entry.ws ??= openWorkspace(root));
  }

  close(): void {
    for (const e of this.open.values()) e.watcher?.close();
    this.open.clear();
  }
}
