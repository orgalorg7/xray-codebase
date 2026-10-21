import type { AnalysisBuilder, SourceFile } from "@xray/parser";
import { type GraphNode, symbolId } from "@xray/schema";
import ts from "typescript";
import { locationOf, moduleSymbolOf } from "./analyze.js";

export type FrameworkContext = {
  sourceFile: ts.SourceFile;
  file: SourceFile;
  moduleId: string;
  builder: AnalysisBuilder;
  checker: ts.TypeChecker;
  targetOf: (symbol: ts.Symbol | undefined) => string | undefined;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const NEXT_HANDLERS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const TEST_FUNCTIONS = new Set(["describe", "suite", "context", "it", "test", "specify"]);
const SUITE_FUNCTIONS = new Set(["describe", "suite", "context"]);
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const isFunctionLike = (
  node: ts.Node | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

const literalText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

/** The identifier at the root of `it.only`, `test.each(rows)`, `describe.skip`, ... */
function rootIdentifier(expr: ts.Expression): string | undefined {
  let current = expr;
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current))
    current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

/**
 * Finds framework entry points (HTTP routes, CLI commands, tests) and adds them as nodes.
 * Returns the inline handler functions they own, so calls inside are attributed to the entry.
 */
export function detectFrameworks(ctx: FrameworkContext): Map<ts.Node, string> {
  const owners = new Map<ts.Node, string>();
  const { sourceFile: sf, file, builder } = ctx;

  const entry = (
    parent: string,
    kind: GraphNode["kind"],
    qualifiedName: string,
    at: ts.Node,
    meta: Record<string, unknown>,
  ): string => {
    const id = symbolId(file.language, file.path, qualifiedName);
    builder.node(file.path, {
      id,
      kind,
      name: qualifiedName,
      qualifiedName,
      language: file.language,
      location: locationOf(at, sf, file.path),
      meta,
    });
    builder.edge(file.path, { source: parent, target: id, kind: "contains", confidence: "exact" });
    return id;
  };

  /** Inline handlers become owned by the entry; named ones get a `handles` edge. */
  const handle = (entryId: string, handler: ts.Node): void => {
    if (isFunctionLike(handler)) {
      owners.set(handler, entryId);
      return;
    }
    const nameNode = ts.isPropertyAccessExpression(handler) ? handler.name : handler;
    const target = ctx.targetOf(ctx.checker.getSymbolAtLocation(nameNode));
    if (target !== undefined) {
      builder.edge(file.path, {
        source: entryId,
        target,
        kind: "handles",
        confidence: "exact",
        location: locationOf(handler, sf, file.path),
      });
    }
  };

  detectFileRoutes(ctx, entry, handle);

  const isTestFile = TEST_FILE.test(file.path);
  const suites: { id: string; title: string }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first, second] = node.arguments;
      const last = node.arguments.at(-1);

      // app.get("/users/:id", auth, handler), router.post(...), fastify.delete(...)
      if (ts.isPropertyAccessExpression(callee) && HTTP_METHODS.has(callee.name.text)) {
        const path = literalText(first);
        if (path?.startsWith("/") && node.arguments.length >= 2) {
          const method = callee.name.text === "all" ? "ANY" : callee.name.text.toUpperCase();
          const id = entry(ctx.moduleId, "route", `${method} ${path}`, node, {
            method,
            path,
            framework: "http",
          });
          for (const handler of node.arguments.slice(1)) handle(id, handler);
        }
      }

      // program.command("serve").action(handler)  |  yargs.command("serve", "desc", builder, handler)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "command") {
        const spec = literalText(first);
        const name = spec?.trim().split(/\s+/)[0];
        if (name && /^[\w:-]+$/.test(name)) {
          const id = entry(ctx.moduleId, "cli-command", `command:${name}`, node, {
            command: name,
            usage: spec,
          });
          if (node.arguments.length >= 3 && last !== undefined && isFunctionLike(last))
            handle(id, last);
          let chain: ts.Node = node;
          for (let hops = 0; hops < 12; hops++) {
            const access = chain.parent;
            if (!ts.isPropertyAccessExpression(access) || !ts.isCallExpression(access.parent))
              break;
            if (access.name.text === "action" && access.parent.arguments[0])
              handle(id, access.parent.arguments[0]);
            chain = access.parent;
          }
        }
      }

      // describe("auth", () => { it("logs in", () => ...) })
      const fn = rootIdentifier(callee);
      const title = literalText(first) ?? (first !== undefined ? "<dynamic>" : undefined);
      const body = isFunctionLike(second) ? second : isFunctionLike(last) ? last : undefined;
      if (isTestFile && fn !== undefined && TEST_FUNCTIONS.has(fn) && title !== undefined && body) {
        const parent = suites.at(-1);
        const titlePath = [...suites.map((suite) => suite.title), title].join(" > ");
        const isSuite = SUITE_FUNCTIONS.has(fn);
        const id = entry(parent?.id ?? ctx.moduleId, "test", `test:${titlePath}`, node, {
          title,
          ...(isSuite ? { suite: true } : {}),
        });
        owners.set(body, id);
        for (const arg of node.arguments) if (arg !== body) visit(arg);
        if (isSuite) suites.push({ id, title });
        visit(body);
        if (isSuite) suites.pop();
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return owners;
}

/** Next.js app router `route.ts` handlers and `pages/api` default exports. */
function detectFileRoutes(
  ctx: FrameworkContext,
  entry: (
    parent: string,
    kind: GraphNode["kind"],
    qualifiedName: string,
    at: ts.Node,
    meta: Record<string, unknown>,
  ) => string,
  handle: (entryId: string, handler: ts.Node) => void,
): void {
  const { file, sourceFile: sf } = ctx;
  const toRoute = (segments: string[]): string =>
    `/${segments.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/")}`;

  const appRoute = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/.exec(file.path);
  if (appRoute) {
    const path = toRoute((appRoute[1] ?? "").split("/").filter(Boolean));
    for (const statement of sf.statements) {
      const names: { name: string; node: ts.Node; nameNode: ts.Node }[] = [];
      const exported =
        ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        names.push({ name: statement.name.text, node: statement, nameNode: statement.name });
      } else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name))
            names.push({ name: decl.name.text, node: decl, nameNode: decl.name });
        }
      }
      for (const { name, node, nameNode } of names) {
        if (!NEXT_HANDLERS.has(name)) continue;
        const id = entry(ctx.moduleId, "route", `${name} ${path}`, node, {
          method: name,
          path,
          framework: "next",
        });
        handle(id, nameNode);
      }
    }
    return;
  }

  const pagesApi = /(?:^|\/)pages\/(api\/(?:[^/]+\/)*[^/]+)\.[cm]?[jt]sx?$/.exec(file.path);
  if (pagesApi) {
    const segments = (pagesApi[1] ?? "").split("/");
    if (segments.at(-1) === "index") segments.pop();
    const path = toRoute(segments);
    const moduleSymbol = moduleSymbolOf(ctx.checker, sf);
    const defaultExport =
      moduleSymbol &&
      ctx.checker.getExportsOfModule(moduleSymbol).find((s) => s.name === "default");
    const target = ctx.targetOf(defaultExport);
    if (target !== undefined) {
      const id = entry(ctx.moduleId, "route", `ANY ${path}`, sf, {
        method: "ANY",
        path,
        framework: "next",
      });
      ctx.builder.edge(file.path, { source: id, target, kind: "handles", confidence: "exact" });
    }
  }
}
