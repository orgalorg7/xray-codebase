import type { SourceLocation } from "@xray/schema";
import type ts from "typescript";

/** Syntax helpers shared by the analyzer and the framework detectors. */

export function locationOf(node: ts.Node, sourceFile: ts.SourceFile, path: string): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: path,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

/**
 * The module symbol of a file. `getSymbolAtLocation` returns nothing for CommonJS files, whose
 * symbol is only reachable through the (untyped but stable) `symbol` property.
 */
export const moduleSymbolOf = (checker: ts.TypeChecker, sf: ts.SourceFile): ts.Symbol | undefined =>
  checker.getSymbolAtLocation(sf) ?? (sf as unknown as { symbol?: ts.Symbol }).symbol;
