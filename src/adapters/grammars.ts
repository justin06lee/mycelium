import { Language, Parser } from "web-tree-sitter";
import goWasm from "tree-sitter-go/tree-sitter-go.wasm" with { type: "file" };
import core from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
// tree-sitter-swift publishes no wasm; this one is built from its 0.7.1 release, patched, by `make grammars`.
import swiftWasm from "../../grammars/tree-sitter-swift.wasm" with { type: "file" };

// Loaded once, up front, so adapters can stay synchronous. The wasm files are embedded in the compiled binary.
await Parser.init({ locateFile: () => core });
const LANGUAGES = {
  go: await Language.load(await Bun.file(goWasm).bytes()),
  swift: await Language.load(await Bun.file(swiftWasm).bytes()),
};

export type Lang = keyof typeof LANGUAGES;

/** A syntax tree node as plain data: tree-sitter's own nodes cross into wasm on every property read. */
export interface Syntax {
  type: string;
  named: boolean;
  /** The field this node fills in its parent, such as "name" or "body". */
  field: string | null;
  /** Offsets into the source string. */
  start: number;
  end: number;
  /** 0-based rows. */
  row: number;
  endRow: number;
  children: Syntax[];
}

const parsers = new Map<Lang, Parser>();

export function parse(lang: Lang, text: string): Syntax {
  let parser = parsers.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(LANGUAGES[lang]);
    parsers.set(lang, parser);
  }
  const tree = parser.parse(text);
  if (!tree) throw new Error(`couldn't parse ${lang}`);
  const cursor = tree.walk();
  const build = (): Syntax => {
    const node: Syntax = {
      type: cursor.nodeType,
      named: cursor.nodeIsNamed,
      field: cursor.currentFieldName,
      start: cursor.startIndex,
      end: cursor.endIndex,
      row: cursor.startPosition.row,
      endRow: cursor.endPosition.row,
      children: [],
    };
    if (cursor.gotoFirstChild()) {
      do node.children.push(build());
      while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
    return node;
  };
  const root = build();
  cursor.delete();
  tree.delete();
  return root;
}

export const child = (n: Syntax, field: string): Syntax | undefined => n.children.find((c) => c.field === field);

/** Code as a token stream without comments, so formatting and comments never count as a change. */
export function tokens(node: Syntax, text: string, out: string[] = []): string[] {
  if (node.type === "comment" || node.type === "multiline_comment") return out;
  if (node.children.length === 0) {
    if (node.end > node.start) out.push(text.slice(node.start, node.end));
    return out;
  }
  // Text a grammar leaves outside any child (some string contents) still counts.
  let at = node.start;
  for (const c of node.children) {
    const gap = text.slice(at, c.start).trim();
    if (gap) out.push(gap);
    tokens(c, text, out);
    at = c.end;
  }
  const tail = text.slice(at, node.end).trim();
  if (tail) out.push(tail);
  return out;
}
