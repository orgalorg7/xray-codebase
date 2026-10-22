import { builtinModules } from "node:module";
import { basename, relative, resolve } from "node:path";
import type { AnalysisBuilder, SourceFile } from "@xray/parser";
import {
  type Confidence,
  externalId,
  type GraphEdge,
  type GraphNode,
  type Language,
  moduleId,
  type SourceLocation,
  symbolId,
} from "@xray/schema";
import ts from "typescript";
import { detectFrameworks } from "./frameworks.js";
import { locationOf, moduleSymbolOf } from "./syntax.js";

export { locationOf, moduleSymbolOf };

const ASSET_IMPORT =
  /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|md|mdx|txt|html|wasm|graphql|gql)$/i;

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

/**
 * Method names so common on built-in types that a name-only match would mostly be wrong.
 * Unresolved calls to these never get a heuristic edge.
 */
const HEURISTIC_STOPLIST = new Set([
  "get",
  "set",
  "has",
  "add",
  "delete",
  "clear",
  "push",
  "pop",
  "shift",
  "unshift",
  "slice",
  "splice",
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
  "includes",
  "indexOf",
  "join",
  "split",
  "concat",
  "keys",
  "values",
  "entries",
  "then",
  "catch",
  "finally",
  "toString",
  "valueOf",
  "call",
  "apply",
  "bind",
  "log",
  "error",
  "warn",
  "info",
  "debug",
  "emit",
  "on",
  "off",
  "once",
  "send",
  "json",
  "end",
  "write",
  "read",
  "close",
  "open",
  "next",
  "resolve",
  "reject",
  "replace",
  "trim",
  "match",
  "test",
  "exec",
  "sort",
  "reverse",
  "length",
  "init",
  "run",
]);

export type Project = {
  root: string;
  builder: AnalysisBuilder;
  /** Project files by absolute path. */
  files: Map<string, SourceFile>;
  /** Declaration key → node ID, shared by every program so cross-program lookups work. */
  declarations: Map<string, string>;
  /** Function and method nodes by short name. */
  callablesByName: Map<string, string[]>;
  /** Method nodes by short name: the only candidates for name-based `x.name()` guesses. */
  methodsByName: Map<string, string[]>;
  /** Top-level nodes per file path, whose `exported` flag the resolution pass fills in. */
  topLevel: Map<string, GraphNode[]>;
};

export const declarationKey = (node: ts.Node): string =>
  `${resolve(node.getSourceFile().fileName)}:${node.pos}:${node.end}`;

export function languageOfPath(path: string): Language | undefined {
  if (/\.d\.[cm]?ts$/.test(path)) return undefined;
  if (/\.[cm]?tsx?$/.test(path)) return "ts";
  if (/\.[cm]?jsx?$/.test(path)) return "js";
  return undefined;
}

const unwrap = (expr: ts.Expression): ts.Expression => {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const isFunctionValue = (
  expr: ts.Expression | undefined,
): expr is ts.ArrowFunction | ts.FunctionExpression =>
  expr !== undefined && (ts.isArrowFunction(unwrap(expr)) || ts.isFunctionExpression(unwrap(expr)));

export const isRequireCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "require" &&
  node.arguments.length === 1 &&
  node.arguments[0] !== undefined &&
  ts.isStringLiteralLike(node.arguments[0]);

/** `require("x")` or `require("x").y`, the initializers that make a variable an import binding. */
const isRequireBinding = (expr: ts.Expression | undefined): boolean => {
  if (expr === undefined) return false;
  const inner = unwrap(expr);
  return (
    isRequireCall(inner) ||
    (ts.isPropertyAccessExpression(inner) && isRequireCall(unwrap(inner.expression)))
  );
};

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
    return true;
  return ts.forEachChild(node, containsJsx) ?? false;
}

const looksLikeComponent = (name: string, body: ts.Node | undefined): boolean =>
  /^[A-Z]/.test(name) && body !== undefined && containsJsx(body);

function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

const isDefaultExport = (node: ts.Node): boolean =>
  (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) !== 0;

const isStatic = (node: ts.Node): boolean =>
  (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;

/**
 * Pass 1: declarations from syntax. Runs over every file before any type checker exists, so
 * resolution can link across all programs while only one program is in memory at a time.
 */
export class DeclarationExtractor {
  readonly #project: Project;

  constructor(project: Project) {
    this.#project = project;
  }

  /** Records a file's declarations from its syntax alone (no type checker needed). */
  extract(file: SourceFile, sf: ts.SourceFile | undefined): void {
    const builder = this.#project.builder;
    const mod = moduleId(file.language, file.path);
    builder.node(file.path, {
      id: mod,
      kind: "module",
      name: basename(file.path),
      qualifiedName: file.path,
      language: file.language,
      location: { file: file.path, line: 1, column: 1 },
    });
    if (sf === undefined) {
      builder.diagnostics.push({
        severity: "warning",
        file: file.path,
        message: "could not be parsed",
      });
      return;
    }

    const topLevel: GraphNode[] = [];
    const declare = (
      parent: string,
      kind: GraphNode["kind"],
      qualifiedName: string,
      decl: ts.Node,
      options: { name?: ts.Node; signatureOf?: ts.Node; meta?: Record<string, unknown> } = {},
    ): string => {
      const id = symbolId(file.language, file.path, qualifiedName);
      const node: GraphNode = {
        id,
        kind,
        name: qualifiedName.split(".").at(-1) ?? qualifiedName,
        qualifiedName,
        language: file.language,
        location: locationOf(decl, sf, file.path),
      };
      const signature = options.signatureOf && this.#signature(options.signatureOf);
      if (signature) node.signature = signature;
      const doc = this.#doc(decl);
      if (doc) node.doc = doc;
      if (parent === mod) topLevel.push(node);
      if (options.meta) node.meta = options.meta;
      builder.node(file.path, node);
      builder.edge(file.path, {
        source: parent,
        target: id,
        kind: "contains",
        confidence: "exact",
      });
      this.#project.declarations.set(declarationKey(decl), id);
      const index = (map: Map<string, string[]>): void => {
        const list = map.get(node.name) ?? [];
        if (!list.includes(id)) list.push(id);
        map.set(node.name, list);
      };
      if (kind === "function" || kind === "method" || kind === "component") {
        index(this.#project.callablesByName);
      }
      if (kind === "method") index(this.#project.methodsByName);
      return id;
    };

    /** `app.render = function () {}` and `Foo.prototype.bar = function () {}` in JS. */
    const declareExpando = (
      owner: string,
      member: string,
      decl: ts.Node,
      value: ts.ArrowFunction | ts.FunctionExpression,
      nameNode: ts.Node,
    ): void => {
      const ownerId = symbolId(file.language, file.path, owner);
      const parent = builder.hasNode(file.path, ownerId) ? ownerId : mod;
      declare(parent, "method", `${owner}.${member}`, decl, { name: nameNode, signatureOf: value });
    };

    const declareClass = (node: ts.ClassLikeDeclaration, name: string, parent: string): void => {
      const heritage = node.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types[0];
      const isReactClass =
        heritage !== undefined && /Component$/.test(heritage.expression.getText(sf));
      const id = declare(parent, isReactClass ? "component" : "class", name, node, {
        name: node.name ?? node,
      });
      for (const member of node.members) {
        let memberKind: GraphNode["kind"] | undefined;
        let memberLabel: string | undefined;
        let signatureOf: ts.Node | undefined;
        const meta: Record<string, unknown> = {};
        if (ts.isMethodDeclaration(member)) {
          memberKind = "method";
          memberLabel = memberName(member.name);
          signatureOf = member;
        } else if (ts.isConstructorDeclaration(member)) {
          memberKind = "method";
          memberLabel = "constructor";
          signatureOf = member;
        } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          memberKind = "method";
          memberLabel = memberName(member.name);
          meta.accessor = ts.isGetAccessorDeclaration(member) ? "get" : "set";
        } else if (ts.isPropertyDeclaration(member)) {
          memberLabel = memberName(member.name);
          memberKind = isFunctionValue(member.initializer) ? "method" : "property";
          if (memberKind === "method") signatureOf = unwrap(member.initializer as ts.Expression);
        }
        if (memberKind === undefined || memberLabel === undefined) continue;
        if (isStatic(member)) meta.static = true;
        declare(id, memberKind, `${name}.${memberLabel}`, member, {
          ...(member.name === undefined ? {} : { name: member.name }),
          ...(signatureOf === undefined ? {} : { signatureOf }),
          ...(Object.keys(meta).length === 0 ? {} : { meta }),
        });
      }
    };

    const declareValue = (
      name: string,
      decl: ts.Node,
      value: ts.Expression | undefined,
      nameNode: ts.Node,
    ): void => {
      const inner = value === undefined ? undefined : unwrap(value);
      if (inner !== undefined && (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner))) {
        const kind = looksLikeComponent(name, inner.body) ? "component" : "function";
        declare(mod, kind, name, decl, { name: nameNode, signatureOf: inner });
      } else if (inner !== undefined && ts.isClassExpression(inner)) {
        declareClass(inner, name, mod);
        this.#project.declarations.set(
          declarationKey(decl),
          symbolId(file.language, file.path, name),
        );
      } else if (
        inner !== undefined &&
        ts.isCallExpression(inner) &&
        looksLikeComponent(name, inner)
      ) {
        // memo(() => <div/>), forwardRef(...) and friends.
        declare(mod, "component", name, decl, { name: nameNode });
      } else {
        declare(mod, "variable", name, decl, { name: nameNode });
      }
    };

    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        const name = statement.name?.text ?? (isDefaultExport(statement) ? "default" : undefined);
        if (name === undefined) continue;
        const kind = looksLikeComponent(name, statement.body) ? "component" : "function";
        declare(mod, kind, name, statement, {
          name: statement.name ?? statement,
          signatureOf: statement,
        });
      } else if (ts.isClassDeclaration(statement)) {
        const name = statement.name?.text ?? (isDefaultExport(statement) ? "default" : undefined);
        if (name !== undefined) declareClass(statement, name, mod);
      } else if (ts.isInterfaceDeclaration(statement)) {
        const id = declare(mod, "interface", statement.name.text, statement, {
          name: statement.name,
        });
        for (const member of statement.members) {
          const label = memberName(member.name);
          if (label === undefined) continue;
          if (ts.isMethodSignature(member)) {
            declare(id, "method", `${statement.name.text}.${label}`, member, {
              name: member.name,
              signatureOf: member,
            });
          } else if (ts.isPropertySignature(member)) {
            declare(id, "property", `${statement.name.text}.${label}`, member, {
              name: member.name,
            });
          }
        }
      } else if (ts.isTypeAliasDeclaration(statement)) {
        declare(mod, "type-alias", statement.name.text, statement, { name: statement.name });
      } else if (ts.isEnumDeclaration(statement)) {
        declare(mod, "enum", statement.name.text, statement, { name: statement.name });
      } else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || isRequireBinding(decl.initializer)) continue;
          declareValue(decl.name.text, decl, decl.initializer, decl.name);
        }
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const value = unwrap(statement.expression);
        if (
          ts.isArrowFunction(value) ||
          ts.isFunctionExpression(value) ||
          ts.isClassExpression(value)
        ) {
          declareValue("default", statement, value, statement);
        }
      } else if (ts.isExpressionStatement(statement)) {
        this.#extractCommonJs(statement, declareValue, declareExpando);
      }
    }

    // Whether each one is exported needs the type checker: decided in the resolution pass.
    this.#project.topLevel.set(file.path, topLevel);
  }

  /** `exports.x = function () {}`, `module.exports.x = ...`, `module.exports = function name() {}`. */
  #extractCommonJs(
    statement: ts.ExpressionStatement,
    declareValue: (
      name: string,
      decl: ts.Node,
      value: ts.Expression | undefined,
      nameNode: ts.Node,
    ) => void,
    declareExpando: (
      owner: string,
      member: string,
      decl: ts.Node,
      value: ts.ArrowFunction | ts.FunctionExpression,
      nameNode: ts.Node,
    ) => void,
  ): void {
    const expr = statement.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      return;
    const value = unwrap(expr.right);
    if (
      !(ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value))
    )
      return;
    const left = expr.left;
    const isModuleExports = (e: ts.Expression): boolean =>
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "module" &&
      e.name.text === "exports";
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(left)) {
      const target = left.expression;
      if ((ts.isIdentifier(target) && target.text === "exports") || isModuleExports(target))
        name = left.name.text;
      else if (isModuleExports(left)) name = value.name?.text ?? "default";
    }
    if (name === undefined && ts.isPropertyAccessExpression(left) && !ts.isClassExpression(value)) {
      // X.prototype.y = function / X.y = function
      const target = left.expression;
      const owner =
        ts.isPropertyAccessExpression(target) &&
        target.name.text === "prototype" &&
        ts.isIdentifier(target.expression)
          ? target.expression.text
          : ts.isIdentifier(target) && target.text !== "module" && target.text !== "exports"
            ? target.text
            : undefined;
      if (owner === undefined) return;
      declareExpando(owner, left.name.text, expr, value, left.name);
      const id = this.#project.declarations.get(declarationKey(expr));
      if (id !== undefined) this.#project.declarations.set(declarationKey(left), id);
      return;
    }
    if (name === undefined) return;
    declareValue(name, expr, value, left);
    // The checker uses either the assignment or its left side as the declaration.
    const id = this.#project.declarations.get(declarationKey(expr));
    if (id !== undefined) this.#project.declarations.set(declarationKey(left), id);
  }

  /**
   * The signature as written: parameters and the declared return type. Printing inferred types
   * instead would make the checker infer every function's full type (slow, memory-hungry and
   * often unreadable for ORM queries or schema builders).
   */
  #signature(node: ts.Node): string | undefined {
    if (!ts.isFunctionLike(node)) return undefined;
    const decl = node as ts.SignatureDeclaration;
    const sf = node.getSourceFile();
    const params = decl.parameters.map((p) => p.getText(sf)).join(", ");
    const returns = decl.type ? `: ${decl.type.getText(sf)}` : "";
    const text = `(${params})${returns}`.replace(/\s+/g, " ");
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
  }

  /** The first paragraph of the declaration's JSDoc, read from the syntax. */
  #doc(decl: ts.Node): string | undefined {
    const docs = ts.getJSDocCommentsAndTags(decl).filter((d): d is ts.JSDoc => ts.isJSDoc(d));
    const comment = docs.at(-1)?.comment;
    const text = typeof comment === "string" ? comment : (ts.getTextOfJSDocComment(comment) ?? "");
    const first = text.split(/\n\s*\n/)[0]?.trim() ?? "";
    if (first === "") return undefined;
    return first.length > 500 ? `${first.slice(0, 497)}...` : first;
  }
}

/** Pass 2: relationships, using one program's type checker. */
export class ProgramAnalyzer {
  readonly #project: Project;
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #host: ts.ModuleResolutionHost;
  readonly #resolutionCache: ts.ModuleResolutionCache;

  constructor(project: Project, program: ts.Program, host: ts.ModuleResolutionHost) {
    this.#project = project;
    this.#program = program;
    this.#checker = program.getTypeChecker();
    this.#host = host;
    this.#resolutionCache = ts.createModuleResolutionCache(
      project.root,
      (name) => name,
      program.getCompilerOptions(),
    );
  }

  #sourceFile(file: SourceFile): ts.SourceFile | undefined {
    return this.#program.getSourceFile(resolve(file.absolutePath));
  }

  /** IDs of the nodes a module exports, including CommonJS `module.exports` forms. */
  #exportedIds(sf: ts.SourceFile): Set<string> {
    const ids = new Set<string>();
    const moduleSymbol = moduleSymbolOf(this.#checker, sf);
    if (moduleSymbol === undefined) return ids;
    const symbols = [
      ...this.#checker.getExportsOfModule(moduleSymbol),
      moduleSymbol.exports?.get(ts.InternalSymbolName.ExportEquals),
    ];
    for (const symbol of symbols) {
      const id = this.targetOf(symbol);
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  // ---- symbol resolution ---------------------------------------------------------------

  #resolveAlias(symbol: ts.Symbol): ts.Symbol {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    try {
      return this.#checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }

  /** The node ID a symbol refers to, following imports, re-exports and CommonJS indirection. */
  targetOf(symbol: ts.Symbol | undefined, depth = 0): string | undefined {
    if (symbol === undefined || depth > 8) return undefined;
    const target = this.#resolveAlias(symbol);
    for (const decl of target.declarations ?? []) {
      const id = this.#project.declarations.get(declarationKey(decl));
      if (id !== undefined) return id;
    }
    for (const decl of target.declarations ?? []) {
      let next: ts.Symbol | undefined;
      if (ts.isShorthandPropertyAssignment(decl)) {
        next = this.#checker.getShorthandAssignmentValueSymbol(decl);
      } else if (ts.isPropertyAssignment(decl) && ts.isIdentifier(unwrap(decl.initializer))) {
        next = this.#checker.getSymbolAtLocation(unwrap(decl.initializer));
      } else if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
        // const { formatDate } = require("./format")
        const property = decl.propertyName ?? decl.name;
        const label = ts.isIdentifier(property) ? property.text : undefined;
        const source = decl.parent.parent;
        if (label !== undefined && ts.isVariableDeclaration(source) && source.initializer) {
          next = this.#checker.getTypeAtLocation(source.initializer).getProperty(label);
        }
      } else if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        isRequireBinding(decl.initializer)
      ) {
        next = this.#checker.getSymbolAtLocation(unwrap(decl.initializer));
      } else if (ts.isBinaryExpression(decl) && ts.isIdentifier(unwrap(decl.right))) {
        // module.exports = Logger
        next = this.#checker.getSymbolAtLocation(unwrap(decl.right));
      } else if (ts.isExportAssignment(decl) && ts.isIdentifier(unwrap(decl.expression))) {
        // export default Logger
        next = this.#checker.getSymbolAtLocation(unwrap(decl.expression));
      }
      if (next !== undefined && next !== target) {
        const id = this.targetOf(next, depth + 1);
        if (id !== undefined) return id;
      }
    }
    // Members of instantiated generics and unions point back to their declarations here.
    for (const root of this.#checker.getRootSymbols(target)) {
      if (root !== target) {
        const id = this.targetOf(root, depth + 1);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  }

  // ---- pass 2: relationships -----------------------------------------------------------

  resolve(file: SourceFile): void {
    const sf = this.#sourceFile(file);
    if (sf === undefined) return;
    const exported = this.#exportedIds(sf);
    for (const node of this.#project.topLevel.get(file.path) ?? []) {
      node.exported = exported.has(node.id);
    }
    const mod = moduleId(file.language, file.path);
    const owners = detectFrameworks({
      sourceFile: sf,
      file,
      moduleId: mod,
      builder: this.#project.builder,
      checker: this.#checker,
      targetOf: (symbol) => this.targetOf(symbol),
    });
    this.#resolveImports(sf, file, mod);
    this.#resolveHeritage(sf, file);
    new BodyWalker(this, this.#checker, sf, file, owners, this.#project).walk(sf, mod);
  }

  #resolveImports(sf: ts.SourceFile, file: SourceFile, mod: string): void {
    const builder = this.#project.builder;
    // Strongest detail wins when one module is imported several ways.
    const rank = (detail: string | undefined): number =>
      detail === undefined ? 0 : detail === "require" ? 1 : detail === "dynamic-import" ? 2 : 3;
    const imports = new Map<string, { detail: string | undefined; location: SourceLocation }>();
    const add = (specifier: ts.StringLiteralLike, detail: string | undefined): void => {
      const target = this.#resolveModule(specifier.text, sf, file);
      if (target === undefined || target === mod) return;
      const previous = imports.get(target);
      if (previous === undefined || rank(detail) < rank(previous.detail)) {
        imports.set(target, { detail, location: locationOf(specifier, sf, file.path) });
      }
    };

    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        const typeOnly =
          clause !== undefined &&
          (clause.isTypeOnly ||
            (clause.name === undefined &&
              clause.namedBindings !== undefined &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.length > 0 &&
              clause.namedBindings.elements.every((element) => element.isTypeOnly)));
        add(statement.moduleSpecifier, typeOnly ? "type-only" : undefined);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        add(statement.moduleSpecifier, statement.isTypeOnly ? "type-only" : undefined);
        this.#resolveReExports(statement, file, mod);
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        this.#resolveLocalReExports(statement.exportClause, file, mod);
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteralLike(statement.moduleReference.expression)
      ) {
        add(statement.moduleReference.expression, statement.isTypeOnly ? "type-only" : undefined);
      }
    }

    const visit = (node: ts.Node): void => {
      if (isRequireCall(node)) add(node.arguments[0] as ts.StringLiteralLike, "require");
      else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        add(node.arguments[0], "dynamic-import");
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const [target, { detail, location }] of imports) {
      const edge: GraphEdge = {
        source: mod,
        target,
        kind: "imports",
        confidence: "exact",
        location,
      };
      if (detail !== undefined) edge.detail = detail;
      builder.edge(file.path, edge);
    }
  }

  /** Module ID for a specifier, an external package node, or undefined (builtins, unresolvable). */
  #resolveModule(specifier: string, sf: ts.SourceFile, file: SourceFile): string | undefined {
    // Stylesheets, images and other assets are bundler concerns, not code dependencies.
    if (ASSET_IMPORT.test(specifier.replace(/[?#].*$/, ""))) return undefined;
    const resolved = ts.resolveModuleName(
      specifier,
      sf.fileName,
      this.#program.getCompilerOptions(),
      this.#host,
      this.#resolutionCache,
    ).resolvedModule;
    if (resolved !== undefined) {
      const target = this.#project.files.get(resolve(resolved.resolvedFileName));
      if (target !== undefined) return moduleId(target.language, target.path);
      const inside = !relative(this.#project.root, resolved.resolvedFileName).startsWith("..");
      if (
        !resolved.isExternalLibraryImport &&
        inside &&
        !resolved.resolvedFileName.includes("/node_modules/")
      ) {
        return undefined; // JSON, .d.ts or other non-source file in the repo.
      }
    } else if (specifier.startsWith(".") || specifier.startsWith("/")) {
      this.#project.builder.diagnostics.push({
        severity: "warning",
        file: file.path,
        message: `cannot resolve import "${specifier}"`,
      });
      return undefined;
    }
    const bare = specifier.replace(/^node:/, "");
    if (specifier.startsWith("node:") || BUILTINS.has(bare.split("/")[0] ?? bare)) return undefined;
    const parts = bare.split("/");
    const name = bare.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? bare);
    const id = externalId("npm", name);
    this.#project.builder.sharedNode({
      id,
      kind: "external",
      name,
      qualifiedName: name,
      meta: { registry: "npm" },
    });
    return id;
  }

  #resolveReExports(statement: ts.ExportDeclaration, file: SourceFile, mod: string): void {
    const builder = this.#project.builder;
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamespaceExport(clause)) return;
    if (clause !== undefined) {
      for (const element of clause.elements) {
        const target = this.targetOf(this.#checker.getSymbolAtLocation(element.name));
        if (target === undefined) continue;
        const edge: GraphEdge = { source: mod, target, kind: "re-exports", confidence: "exact" };
        if (element.propertyName && element.propertyName.text !== element.name.text) {
          edge.detail = `alias:${element.name.text}`;
        }
        builder.edge(file.path, edge);
      }
      return;
    }
    const moduleSymbol =
      statement.moduleSpecifier && this.#checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (moduleSymbol === undefined) return;
    for (const symbol of this.#checker.getExportsOfModule(moduleSymbol)) {
      const target = this.targetOf(symbol);
      if (target !== undefined) {
        builder.edge(file.path, {
          source: mod,
          target,
          kind: "re-exports",
          confidence: "exact",
          detail: "star",
        });
      }
    }
  }

  /** `import { a } from "./x"; export { a }` re-exports a symbol declared elsewhere. */
  #resolveLocalReExports(clause: ts.NamedExports, file: SourceFile, mod: string): void {
    const ownPrefix = `${mod}#`;
    for (const element of clause.elements) {
      const local = this.#checker.getExportSpecifierLocalTargetSymbol(element);
      const target = this.targetOf(local);
      if (target === undefined || target.startsWith(ownPrefix)) continue;
      const edge: GraphEdge = { source: mod, target, kind: "re-exports", confidence: "exact" };
      if (element.propertyName && element.propertyName.text !== element.name.text) {
        edge.detail = `alias:${element.name.text}`;
      }
      this.#project.builder.edge(file.path, edge);
    }
  }

  #resolveHeritage(sf: ts.SourceFile, file: SourceFile): void {
    const builder = this.#project.builder;
    const visitClass = (node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): void => {
      const id = this.#project.declarations.get(declarationKey(node));
      if (id === undefined) return;
      for (const clause of node.heritageClauses ?? []) {
        const kind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
        for (const type of clause.types) {
          const target = this.targetOf(this.#checker.getSymbolAtLocation(type.expression));
          if (target !== undefined && target !== id) {
            builder.edge(file.path, {
              source: id,
              target,
              kind,
              confidence: "exact",
              location: locationOf(type, sf, file.path),
            });
          }
        }
      }
      if (ts.isClassLike(node)) this.#resolveOverrides(node, id, sf, file);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) visitClass(node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  #resolveOverrides(
    node: ts.ClassLikeDeclaration,
    classId: string,
    sf: ts.SourceFile,
    file: SourceFile,
  ): void {
    const symbol = node.name
      ? this.#checker.getSymbolAtLocation(node.name)
      : this.#checker.getSymbolAtLocation(node);
    const classSymbol = symbol ?? (node as { symbol?: ts.Symbol }).symbol;
    if (classSymbol === undefined) return;
    const instanceType = this.#checker.getDeclaredTypeOfSymbol(classSymbol);
    const bases = instanceType.isClassOrInterface() ? this.#checker.getBaseTypes(instanceType) : [];
    const implemented = (node.heritageClauses ?? [])
      .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
      .flatMap((clause) => clause.types.map((type) => this.#checker.getTypeAtLocation(type)));

    for (const member of node.members) {
      if (isStatic(member) || ts.isConstructorDeclaration(member)) continue;
      const memberId = this.#project.declarations.get(declarationKey(member));
      const label = memberName(member.name);
      if (memberId === undefined || label === undefined) continue;
      const link = (type: ts.Type, detail?: string): boolean => {
        const target = this.targetOf(type.getProperty(label));
        if (target === undefined || target === memberId || target.startsWith(`${classId}.`))
          return false;
        const edge: GraphEdge = {
          source: memberId,
          target,
          kind: "overrides",
          confidence: "exact",
          location: locationOf(member, sf, file.path),
        };
        if (detail !== undefined) edge.detail = detail;
        this.#project.builder.edge(file.path, edge);
        return true;
      };
      for (const base of bases) if (link(base)) break;
      for (const type of implemented) link(type, "implements");
    }
  }

  /** Receiver-based calls in JS have no declared types, so their resolution is inferred. */
  confidenceFor(file: SourceFile, receiver: ts.Expression | undefined): Confidence {
    if (file.language === "ts" || receiver === undefined) return "exact";
    const inner = unwrap(receiver);
    if (inner.kind === ts.SyntaxKind.ThisKeyword || inner.kind === ts.SyntaxKind.SuperKeyword)
      return "exact";
    if (ts.isIdentifier(inner)) {
      const symbol = this.#checker.getSymbolAtLocation(inner);
      if (symbol === undefined) return "inferred";
      const definite =
        ts.SymbolFlags.Alias |
        ts.SymbolFlags.Class |
        ts.SymbolFlags.Enum |
        ts.SymbolFlags.ValueModule |
        ts.SymbolFlags.Function;
      if ((symbol.flags & definite) !== 0) return "exact";
      const decl = symbol.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && isRequireBinding(decl.initializer))
        return "exact";
    }
    return "inferred";
  }

  heuristicTarget(name: string): string | undefined {
    if (HEURISTIC_STOPLIST.has(name) || name.length < 3) return undefined;
    const candidates = this.#project.methodsByName.get(name);
    return candidates?.length === 1 ? candidates[0] : undefined;
  }
}

/** Walks code bodies, attributing calls, instantiations and references to their owner node. */
class BodyWalker {
  readonly #references = new Set<string>();
  readonly #handled = new Set<ts.Node>();

  constructor(
    readonly analyzer: ProgramAnalyzer,
    readonly checker: ts.TypeChecker,
    readonly sf: ts.SourceFile,
    readonly file: SourceFile,
    readonly owners: Map<ts.Node, string>,
    readonly project: Project,
  ) {}

  walk(node: ts.Node, owner: string, inType = false): void {
    const own = this.owners.get(node) ?? this.#ownerDeclaration(node) ?? owner;
    const typeContext = inType || ts.isTypeNode(node);

    if (ts.isCallExpression(node)) this.#call(node, own);
    else if (ts.isNewExpression(node)) this.#new(node, own);
    else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) this.#jsx(node, own);
    else if (ts.isIdentifier(node)) this.#reference(node, own, typeContext);

    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isHeritageClause(node)
    ) {
      return;
    }
    ts.forEachChild(node, (child) => this.walk(child, own, typeContext));
  }

  #ownerDeclaration(node: ts.Node): string | undefined {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isAccessor(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isClassLike(node) ||
      ts.isVariableDeclaration(node) ||
      (ts.isBinaryExpression(node) && ts.isSourceFile(node.parent.parent)) ||
      ts.isExportAssignment(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      return this.project.declarations.get(declarationKey(node));
    }
    return undefined;
  }

  #edge(edge: GraphEdge): void {
    this.project.builder.edge(this.file.path, edge);
  }

  #call(node: ts.CallExpression, owner: string): void {
    // Cast: the type guard would narrow `node` to never in the else branch.
    if (isRequireCall(node as ts.Node) || node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      this.#handled.add(node.expression);
      return;
    }
    const callee = unwrap(node.expression);
    const location = locationOf(node, this.sf, this.file.path);
    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      // super(...) runs the base class constructor, when the base declares one.
      const base = this.#baseClassOf(node);
      const constructorId = base && `${base}.constructor`;
      if (
        constructorId &&
        this.project.callablesByName.get("constructor")?.includes(constructorId)
      ) {
        this.#edge({
          source: owner,
          target: constructorId,
          kind: "calls",
          confidence: "exact",
          detail: "super-call",
          location,
        });
      }
      return;
    }
    let nameNode: ts.Node | undefined;
    let receiver: ts.Expression | undefined;
    if (ts.isIdentifier(callee)) nameNode = callee;
    else if (ts.isPropertyAccessExpression(callee)) {
      nameNode = callee.name;
      receiver = callee.expression;
    } else if (
      ts.isElementAccessExpression(callee) &&
      ts.isStringLiteralLike(callee.argumentExpression)
    ) {
      nameNode = callee.argumentExpression;
      receiver = callee.expression;
    }
    if (nameNode === undefined) return;
    this.#handled.add(nameNode);

    const symbol = this.checker.getSymbolAtLocation(nameNode);
    let target = this.analyzer.targetOf(symbol);
    let confidence = this.analyzer.confidenceFor(this.file, receiver);
    if (
      target === undefined &&
      symbol === undefined &&
      receiver !== undefined &&
      !this.#rootsInImport(receiver)
    ) {
      const name =
        ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) ? nameNode.text : undefined;
      target = name === undefined ? undefined : this.analyzer.heuristicTarget(name);
      if (target === owner) target = undefined;
      confidence = "heuristic";
    }
    if (target === undefined) return;
    const edge: GraphEdge = { source: owner, target, kind: "calls", confidence, location };
    const inner = receiver && unwrap(receiver);
    if (inner?.kind === ts.SyntaxKind.ThisKeyword) edge.detail = "self-call";
    else if (inner?.kind === ts.SyntaxKind.SuperKeyword) edge.detail = "super-call";
    this.#edge(edge);
  }

  /**
   * Whether an expression like `z.string().min` starts from an import binding or an undeclared
   * global. Such receivers are known, just unresolvable (an uninstalled package, missing
   * `@types`), so name-based guesses would mislead.
   */
  #rootsInImport(expr: ts.Expression): boolean {
    let root: ts.Expression = unwrap(expr);
    while (
      ts.isPropertyAccessExpression(root) ||
      ts.isElementAccessExpression(root) ||
      ts.isCallExpression(root)
    ) {
      root = unwrap(root.expression);
    }
    if (!ts.isIdentifier(root)) return false;
    const symbol = this.checker.getSymbolAtLocation(root);
    // Undeclared roots are environment globals (process, window) whose types are not loaded.
    if (symbol === undefined) return true;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) return true;
    const decl = symbol.valueDeclaration;
    return (
      decl !== undefined && ts.isVariableDeclaration(decl) && isRequireBinding(decl.initializer)
    );
  }

  #baseClassOf(node: ts.Node): string | undefined {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined && !ts.isClassLike(current)) current = current.parent;
    const heritage = current?.heritageClauses?.find(
      (c) => c.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const base = heritage?.types[0]?.expression;
    return base && this.analyzer.targetOf(this.checker.getSymbolAtLocation(base));
  }

  #new(node: ts.NewExpression, owner: string): void {
    const callee = unwrap(node.expression);
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    this.#handled.add(nameNode);
    const target = this.analyzer.targetOf(this.checker.getSymbolAtLocation(nameNode));
    if (target === undefined) return;
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined;
    this.#edge({
      source: owner,
      target,
      kind: "instantiates",
      confidence: this.analyzer.confidenceFor(this.file, receiver),
      location: locationOf(node, this.sf, this.file.path),
    });
  }

  #jsx(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, owner: string): void {
    const tag = node.tagName;
    const nameNode = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
    this.#handled.add(nameNode);
    if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return; // intrinsic element like <div>
    const target = this.analyzer.targetOf(this.checker.getSymbolAtLocation(nameNode));
    if (target === undefined) return;
    this.#edge({
      source: owner,
      target,
      kind: "calls",
      confidence: "exact",
      detail: "jsx",
      location: locationOf(node, this.sf, this.file.path),
    });
  }

  /** `this`, `super`, or a name bound to an import, class, enum, namespace or function. */
  #cheapReceiver(expr: ts.Expression): boolean {
    const inner = unwrap(expr);
    if (inner.kind === ts.SyntaxKind.ThisKeyword || inner.kind === ts.SyntaxKind.SuperKeyword)
      return true;
    if (!ts.isIdentifier(inner)) return false;
    const symbol = this.checker.getSymbolAtLocation(inner);
    const cheap =
      ts.SymbolFlags.Alias |
      ts.SymbolFlags.Class |
      ts.SymbolFlags.Enum |
      ts.SymbolFlags.Module |
      ts.SymbolFlags.Function;
    return symbol !== undefined && (symbol.flags & cheap) !== 0;
  }

  #reference(node: ts.Identifier, owner: string, inType: boolean): void {
    if (this.#handled.has(node)) return;
    const parent = node.parent;
    const isDeclarationName =
      !ts.isPropertyAccessExpression(parent) &&
      !ts.isQualifiedName(parent) &&
      ts.getNameOfDeclaration(parent as ts.Declaration) === node;
    if (isDeclarationName) return;
    if (ts.isJsxAttribute(parent) || ts.isJsxClosingElement(parent)) return;
    // Resolving `x.prop` means inferring the type of `x`, which for long chains over ORM or
    // schema types is very expensive. References are only followed where the receiver is cheap
    // to know; calls (handled separately) still resolve any receiver.
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.name === node &&
      !this.#cheapReceiver(parent.expression)
    ) {
      return;
    }
    const symbol = this.checker.getSymbolAtLocation(node);
    const target = this.analyzer.targetOf(symbol);
    if (target === undefined || target === owner || target.startsWith(`${owner}.`)) return;
    // Module-level variables are state: say whether this code reads or writes it.
    const access =
      !inType && isModuleVariable(this.checker, symbol) ? stateAccess(node) : undefined;
    const key = `${owner}\u0000${target}\u0000${access ?? ""}`;
    if (this.#references.has(key)) return;
    this.#references.add(key);
    const edge: GraphEdge = {
      source: owner,
      target,
      kind: "references",
      confidence: "exact",
      location: locationOf(node, this.sf, this.file.path),
    };
    if (inType) edge.detail = "type";
    else if (access) edge.detail = access;
    this.#edge(edge);
  }
}

/** Whether a symbol is a variable declared at the top level of a module (`let cache = …`). */
function isModuleVariable(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean {
  const resolved =
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = resolved?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    ts.isSourceFile(declaration.parent.parent.parent)
  );
}

/** Methods that change the collection they are called on. */
const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "set",
  "add",
  "delete",
  "clear",
  "assign",
]);

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

/**
 * Whether a use of a variable changes it: assigning it or a property or element of it,
 * `++`/`--`, `delete`, or calling a mutating method on it (`cache.set(…)`, `list.push(…)`).
 */
function stateAccess(node: ts.Identifier): "reads" | "writes" {
  let expr: ts.Node = node;
  while (
    (ts.isPropertyAccessExpression(expr.parent) || ts.isElementAccessExpression(expr.parent)) &&
    expr.parent.expression === expr
  ) {
    expr = expr.parent;
  }
  const parent = expr.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === expr &&
    ASSIGNMENTS.has(parent.operatorToken.kind)
  ) {
    return "writes";
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return "writes";
  }
  if (ts.isDeleteExpression(parent)) return "writes";
  const method = node.parent;
  if (
    ts.isPropertyAccessExpression(method) &&
    method.expression === node &&
    MUTATORS.has(method.name.text) &&
    ts.isCallExpression(method.parent) &&
    method.parent.expression === method
  ) {
    return "writes";
  }
  return "reads";
}
