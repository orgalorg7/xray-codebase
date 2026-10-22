import type { SourceFile, SyntaxNode, Tree } from "@xray/parser";
import type { Call, Decl, Expr, FileModel, Import, Route } from "./model.js";
import { newDecl } from "./model.js";

/**
 * Collects one file's model while an extractor walks its tree: declarations (with their
 * containers and qualified names), imports, calls and routes.
 */
export class Extraction {
  readonly model: FileModel;
  readonly #byName = new Map<string, Decl>();

  constructor(file: SourceFile, tree: Tree, isTest = false) {
    this.model = {
      path: file.path,
      language: file.language,
      tree,
      namespace: "",
      decls: [],
      imports: [],
      calls: [],
      accesses: [],
      routes: [],
      impls: [],
      modules: [],
      isTest,
    };
  }

  /**
   * Adds a declaration inside `parent` (or at the top level). A class-like declaration with the
   * same qualified name as an earlier one (Ruby's reopened classes, C# partial classes) is the
   * same declaration: the earlier one is returned.
   */
  declare(
    init: Pick<Decl, "kind" | "name" | "node" | "exported"> & Partial<Decl>,
    parent?: Decl,
  ): Decl {
    const qualifiedName =
      init.qualifiedName ?? (parent ? `${parent.qualifiedName}.${init.name}` : init.name);
    const existing = this.#byName.get(qualifiedName);
    if (existing && (init.kind === existing.kind || init.kind === "class")) return existing;
    const decl = newDecl({ ...init, qualifiedName, ...(parent ? { parent } : {}) });
    this.model.decls.push(decl);
    parent?.members.push(decl);
    if (!existing) this.#byName.set(qualifiedName, decl);
    return decl;
  }

  call(from: Decl | undefined, callee: Expr, node: SyntaxNode, kind: Call["kind"] = "call"): void {
    this.model.calls.push({ ...(from ? { from } : {}), callee, node, kind });
  }

  access(from: Decl, name: string, node: SyntaxNode, write: boolean): void {
    this.model.accesses.push({ from, name, node, write });
  }

  import(imp: Import): void {
    this.model.imports.push(imp);
  }

  route(route: Route): void {
    this.model.routes.push(route);
  }
}

/** HTTP methods by the names routing APIs give them (`get`, `GET`, `MapGet`, `HttpGet`). */
export function httpMethod(name: string): string | undefined {
  const verb = name.replace(/^(Map|Http|handle)/, "").toUpperCase();
  return ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(verb)
    ? verb
    : undefined;
}
