import { Language, Parser } from "web-tree-sitter";

let initialized: Promise<void> | undefined;
const grammars = new Map<string, Promise<Language>>();

/** Initializes the tree-sitter runtime once per process. */
export function initTreeSitter(): Promise<void> {
  initialized ??= Parser.init();
  return initialized;
}

/** Loads a grammar from a `.wasm` file, caching it per path. */
export function loadGrammar(wasmPath: string): Promise<Language> {
  let grammar = grammars.get(wasmPath);
  if (grammar === undefined) {
    grammar = initTreeSitter().then(() => Language.load(wasmPath));
    grammars.set(wasmPath, grammar);
  }
  return grammar;
}

/** Creates a parser for the grammar at `wasmPath`. */
export async function createParser(wasmPath: string): Promise<Parser> {
  const grammar = await loadGrammar(wasmPath);
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser;
}

export type { Node as SyntaxNode, Parser, Tree } from "web-tree-sitter";
