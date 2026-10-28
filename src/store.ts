import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Entry } from "./types.ts";

const MARKERS = [".mycelium", ".git", "package.json", "Package.swift"];

/** The nearest directory at or above `from` that looks like a project root. */
export function findRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

export class Store {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = join(root, ".mycelium", "components");
  }

  all(): Entry[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Entry)
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(slug: string): Entry | undefined {
    const path = join(this.dir, `${slug}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Entry) : undefined;
  }

  put(entry: Entry): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${entry.slug}.json`), JSON.stringify(entry, null, 2) + "\n");
  }

  remove(slug: string): boolean {
    const path = join(this.dir, `${slug}.json`);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }
}
