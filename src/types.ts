/** Where a component starts: the declaration everything else is traced from. */
export interface RootRef {
  /** Path from the workspace root, always with forward slashes. */
  file: string;
  /** Declared name, or "default" for an anonymous default export. */
  symbol: string;
}

export type CandidateKind = "screen" | "layout" | "component";

/** A component the analyzer found in the code, registered or not. */
export interface Candidate extends RootRef {
  kind: CandidateKind;
  exported: boolean;
  default: boolean;
  line: number;
}

export interface Chunk {
  file: string;
  kind: "code" | "style" | "asset";
  /** 1-based inclusive line ranges; absent when the whole file belongs to the component. */
  ranges?: [number, number][];
  /** Source text, or undefined for binary or oversized assets. */
  text?: string;
  /** Fingerprint of the normalized content (comments and whitespace ignored). */
  hash: string;
}

/** Everything that makes up one component, traced from its root. */
export interface Slice {
  root: RootRef & { line: number; default: boolean };
  chunks: Chunk[];
  /** Roots of other registered components this one renders. */
  uses: RootRef[];
  /** Files it depends on that other code shares, so they are linked rather than included. */
  shared: string[];
  /** Fingerprint of the root declaration with its own name blanked, for rename detection. */
  shape: string;
  /** Normalized root declaration, for fuzzy matching when the shape changed too. */
  rootText: string;
}

export interface SliceOptions {
  /** Roots of other registered components: tracing stops there and records a "uses" link. */
  boundaries: RootRef[];
  /** Files pinned to the component by hand, included whole. */
  pins: string[];
}

/** One language's view of a workspace. The TS adapter is the first; Swift will be another. */
export interface Workspace {
  root: string;
  discover(): Candidate[];
  /** Undefined when the root no longer exists. */
  slice(root: RootRef, opts: SliceOptions): Slice | undefined;
  /** Files that import the root, from the workspace root. */
  usedBy(root: RootRef): string[];
  /** The root declaration's shape and normalized text, without tracing the rest. */
  rootShape(root: RootRef): { shape: string; rootText: string } | undefined;
}

export interface Fingerprint {
  hash: string;
  files: Record<string, string>;
  shape: string;
  rootText: string;
}

/** A registered component, stored as .mycelium/components/<slug>.json. */
export interface Entry {
  slug: string;
  name: string;
  aliases: string[];
  note: string;
  tags: string[];
  root: RootRef;
  pins: string[];
  fingerprint?: Fingerprint;
  createdAt: string;
  updatedAt: string;
}
