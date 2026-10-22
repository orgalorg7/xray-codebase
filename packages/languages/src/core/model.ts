import type { SyntaxNode, Tree } from "@xray/parser";
import type { Language, NodeKind } from "@xray/schema";

/**
 * The language-neutral picture of a file that every extractor produces and the shared resolver
 * consumes: declarations, imports, call sites and routes, with just enough of each expression
 * to follow it to a declaration.
 */

/** A type as written, without generic arguments: `["m", "User"]` for `m.User`, `["List"]`. */
export type TypeName = string[];

/** The parts of an expression the resolver can follow. */
export type Expr =
  | { kind: "name"; name: string }
  | { kind: "this" }
  | { kind: "super" }
  | { kind: "member"; object: Expr; name: string }
  /** The value a call returns. */
  | { kind: "call"; callee: Expr }
  /** A newly constructed value of a type. */
  | { kind: "new"; type: TypeName }
  | { kind: "unknown" };

/** How a local variable got its type: declared (`User u`, `u: User`) or from its initializer. */
export type Local = { type?: TypeName; init?: Expr };

export type Annotation = {
  /** Last segment of the annotation, attribute or decorator name: `GetMapping`, `Test`. */
  name: string;
  /** String literal arguments, in order, with named ones keyed (`value`, `path`, `methods`). */
  strings: string[];
  named: Record<string, string[]>;
  node: SyntaxNode;
};

export type Decl = {
  kind: NodeKind;
  name: string;
  /** Unique within the file: `Repo.Find`, `UserService.Companion.create`. */
  qualifiedName: string;
  node: SyntaxNode;
  doc?: string;
  signature?: string;
  exported: boolean;
  /** The declaration lexically containing this one. */
  parent?: Decl;
  /** The type a detached method belongs to (Go receivers, Rust `impl` blocks). */
  owner?: TypeName;
  members: Decl[];
  /** Supertypes; `relation` is unknown where the syntax does not say (Kotlin, C#). */
  bases: { type: TypeName; relation: "extends" | "implements" | "unknown" }[];
  /** A field's or variable's type, or what a function returns. */
  type?: TypeName;
  static?: boolean;
  annotations: Annotation[];
  /** Variables and parameters of a function, by name. */
  locals: Map<string, Local>;
  meta?: Record<string, unknown>;
};

export type Import = {
  /** As written: `example.com/app/models`, `com.acme.Util`, `crate::store::Repo`, `App\Models\User`. */
  path: string;
  /** The name it binds, when given explicitly. */
  alias?: string;
  /** `import com.acme.*`, `use crate::store::*`, `using Acme.App;`, Go dot imports. */
  wildcard?: boolean;
  node: SyntaxNode;
  /** Ruby: `require` or `require_relative`; PHP: `use function`. */
  form?: string;
  /** Re-exported to importers of this file (Rust `pub use`). */
  exported?: boolean;
};

export type Call = {
  /** The innermost enclosing function, method or variable; the module when undefined. */
  from?: Decl;
  /** What is called; for `kind: "new"` the type being constructed. */
  callee: Expr;
  node: SyntaxNode;
  kind: "call" | "new";
};

/** A use of a name that may be module state: a read, or a write (assignment, `++`, mutation). */
export type Access = { from: Decl; name: string; node: SyntaxNode; write: boolean };

export type Route = {
  method: string;
  path: string;
  node: SyntaxNode;
  framework: string;
  /** A named handler; inline handlers leave it out. */
  handler?: Decl | Expr;
  /** The function registering the route, in which a handler expression is evaluated. */
  from?: Decl;
};

export type FileModel = {
  path: string;
  language: Language;
  tree: Tree;
  /** Package or namespace as declared (`store`, `com.acme.store`, `App\Models`); "" if none. */
  namespace: string;
  /** Every declaration, nested ones included, in source order. */
  decls: Decl[];
  imports: Import[];
  calls: Call[];
  /** Uses of names inside functions, resolved to module-level variables if they are any. */
  accesses: Access[];
  routes: Route[];
  /** Rust `impl Trait for Type` blocks, which add supertypes to a type declared elsewhere. */
  impls: { type: TypeName; trait: TypeName }[];
  /** Rust `mod name;` declarations, which pull files into the module tree. */
  modules: string[];
  isTest: boolean;
};

/** The expression naming a type: `Foo` or `pkg.Foo`. */
export function typeExpr(type: TypeName): Expr {
  const [first = "", ...rest] = type;
  return rest.reduce<Expr>((object, name) => ({ kind: "member", object, name }), {
    kind: "name",
    name: first,
  });
}

/** A new declaration with empty collections. */
export function newDecl(
  init: Pick<Decl, "kind" | "name" | "qualifiedName" | "node" | "exported"> & Partial<Decl>,
): Decl {
  return { members: [], bases: [], annotations: [], locals: new Map(), ...init };
}

export const CLASS_LIKE: ReadonlySet<NodeKind> = new Set(["class", "interface", "enum"]);
export const CALLABLE: ReadonlySet<NodeKind> = new Set(["function", "method", "test"]);
