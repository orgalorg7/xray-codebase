import type { SyntaxNode } from "@xray/parser";
import type { SourceLocation } from "@xray/schema";

/** Helpers over tree-sitter nodes shared by every extractor. */

/**
 * Whether two handles are the same node. web-tree-sitter returns a new object on every access,
 * so `===` never holds between two lookups of one node.
 */
export const same = (a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean =>
  !!a && !!b && a.id === b.id;

export const field = (node: SyntaxNode, name: string): SyntaxNode | null =>
  node.childForFieldName(name);

export const fields = (node: SyntaxNode, name: string): SyntaxNode[] =>
  node.childrenForFieldName(name).filter((n): n is SyntaxNode => n !== null);

export const named = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((n): n is SyntaxNode => n !== null);

/** The first named child of one of the types. */
export const childOf = (node: SyntaxNode, ...types: string[]): SyntaxNode | undefined =>
  named(node).find((child) => types.includes(child.type));

export const childrenOf = (node: SyntaxNode, ...types: string[]): SyntaxNode[] =>
  named(node).filter((child) => types.includes(child.type));

/** Every descendant (preorder), not entering subtrees for which `skip` is true. */
export function* descendants(
  node: SyntaxNode,
  skip?: (node: SyntaxNode) => boolean,
): Generator<SyntaxNode> {
  for (const child of named(node)) {
    yield child;
    if (!skip?.(child)) yield* descendants(child, skip);
  }
}

export function locationOf(node: SyntaxNode, path: string): SourceLocation {
  return {
    file: path,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

/** Collapses whitespace and shortens to `max` characters. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const COMMENT = /comment/;

/** Text of a comment without its markers: `//`, `///`, `#`, `/** … *\/`, leading `*`. */
function commentText(text: string): string {
  return text
    .replace(/^\/\*+!?|\*+\/$/g, "")
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^(\/\/[/!]?|#+|\*+(?!\/))\s?/, "")
        .trim(),
    )
    .join("\n");
}

/**
 * The documentation comment right above a declaration (or its first annotation): consecutive
 * comment nodes ending on the line before. Returns the first paragraph, without tags.
 */
export function docComment(node: SyntaxNode): string | undefined {
  const comments: SyntaxNode[] = [];
  let line = node.startPosition.row;
  let previous = node.previousNamedSibling;
  while (previous && COMMENT.test(previous.type) && previous.endPosition.row >= line - 1) {
    comments.unshift(previous);
    line = previous.startPosition.row;
    previous = previous.previousNamedSibling;
  }
  if (comments.length === 0) return undefined;
  const text = comments
    .map((c) => commentText(c.text))
    .join("\n")
    .split(/\n\s*\n|\n\s*[@:]/)[0]
    ?.replace(/<\/?[a-z]+[^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^(TODO|FIXME|eslint|nolint|go:)/i.test(text)) return undefined;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * The value of a plain string literal (no interpolation), whatever the language's quoting:
 * "…", '…', `…`, """…""", @"…", r"…", r#"…"#. Undefined for anything else.
 */
export function stringValue(node: SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (named(node).some((child) => /interpolation|substitution|template/.test(child.type))) {
    return undefined;
  }
  if (!/string|literal|text/.test(node.type)) return undefined;
  const match =
    /^(?:[@rbcu]|r#+)?("""|'''|"|'|`)([\s\S]*)\1#*$/.exec(node.text) ??
    /^%[qQw]?[({[<]([\s\S]*)[)}\]>]$/.exec(node.text);
  if (!match) return undefined;
  const body = match.length === 3 ? (match[2] as string) : (match[1] as string);
  return body.replace(/\\(["'\\/])/g, "$1");
}

/** Removes generic arguments and pointer/reference/array marks from a type's text. */
export function typeText(text: string): string {
  let out = "";
  let depth = 0;
  for (const c of text) {
    if (c === "<" || c === "[") depth++;
    else if (c === ">" || c === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out.replace(/[*&?!\s]|\bmut\b|\bconst\b|\bdyn\b|\bimpl\b|^\[\]/g, "").trim();
}

/** Splits a type's text on the language's path separators (`.`, `::`, `\`). */
export function typeName(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const parts = typeText(text)
    .split(/::|\\|\./)
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(p))
    ? parts
    : undefined;
}
