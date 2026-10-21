import type { SyntaxNode } from "@xray/parser";
import { type SourceLocation, symbolId } from "@xray/schema";
import type { Def, ModuleInfo } from "./extract.js";

/** Node helpers shared by the resolver and the framework detectors. */

export function locationOf(node: SyntaxNode, path: string): SourceLocation {
  return {
    file: path,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

export const defId = (mod: ModuleInfo, def: Def): string =>
  symbolId("py", mod.path, def.qualifiedName);
