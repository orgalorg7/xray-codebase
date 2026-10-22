import { posix } from "node:path";
import type { SourceFile, SyntaxNode, Tree } from "@xray/parser";
import { joinRoute } from "./core/annotations.js";
import { Extraction, httpMethod } from "./core/extraction.js";
import type { Decl, Expr, FileModel, TypeName } from "./core/model.js";
import type { LanguageDefinition } from "./core/plugin.js";
import type { ImportResult, LanguageRules, Project } from "./core/resolve.js";
import {
  childOf,
  descendants,
  docComment,
  field,
  named,
  oneLine,
  stringValue,
} from "./core/syntax.js";

const TEST_FILE = /(^|\/)(spec|test)\/|_(spec|test)\.rb$/;

/** Libraries that ship with Ruby: required, but not gems. */
const STANDARD = new Set(
  "json set time date yaml csv uri net/http net/https open-uri fileutils securerandom digest logger open3 erb ostruct optparse pathname tempfile benchmark forwardable singleton english base64 stringio socket timeout zlib bigdecimal observer delegate shellwords pp prettyprint io/console etc find monitor".split(
    " ",
  ),
);

/** `Shop::UserRepo` → ["Shop", "UserRepo"]. */
function constant(node: SyntaxNode | null | undefined): TypeName | undefined {
  if (!node) return undefined;
  if (node.type === "constant") return [node.text];
  if (node.type === "scope_resolution") {
    const scope = constant(field(node, "scope"));
    const name = field(node, "name")?.text ?? "";
    return scope ? [...scope, name] : [name];
  }
  return undefined;
}

function rubyExpr(node: SyntaxNode | null | undefined): Expr {
  if (!node) return { kind: "unknown" };
  switch (node.type) {
    case "identifier":
    case "constant":
      return { kind: "name", name: node.text };
    case "self":
      return { kind: "this" };
    case "instance_variable":
      return { kind: "member", object: { kind: "this" }, name: node.text.slice(1) };
    case "scope_resolution":
      return {
        kind: "member",
        object: field(node, "scope") ? rubyExpr(field(node, "scope")) : { kind: "unknown" },
        name: field(node, "name")?.text ?? "",
      };
    case "call":
      return { kind: "call", callee: rubyCallee(node) };
    case "parenthesized_statements":
      return rubyExpr(named(node)[0]);
    default:
      return { kind: "unknown" };
  }
}

function rubyCallee(call: SyntaxNode): Expr {
  const name = field(call, "method")?.text ?? "";
  const receiver = field(call, "receiver");
  if (name === "super" || field(call, "method")?.type === "super") return { kind: "super" };
  return receiver ? { kind: "member", object: rubyExpr(receiver), name } : { kind: "name", name };
}

/** Nodes whose children are statements. */
const STATEMENT = /^(body_statement|then|else|do|begin|ensure|block_body|program)$/;

/** RSpec/minitest-spec blocks that describe and test behavior. */
const SPEC_GROUPS = new Set(["describe", "context", "feature", "RSpec.describe"]);
const SPEC_TESTS = new Set(["it", "specify", "scenario", "example", "test"]);

function extractRuby(tree: Tree, file: SourceFile): FileModel {
  const x = new Extraction(file, tree, TEST_FILE.test(file.path));
  const isRoutes = /(^|\/)config\/routes\.rb$/.test(file.path);

  const scan = (body: SyntaxNode, from: Decl | undefined): void => {
    for (const n of descendants(
      body,
      (d) =>
        d.type === "method" ||
        d.type === "singleton_method" ||
        d.type === "class" ||
        d.type === "module",
    )) {
      if (n.type === "call") {
        const method = field(n, "method")?.text ?? "";
        const receiver = field(n, "receiver");
        if (!receiver && (method === "require" || method === "require_relative")) continue;
        // A bare `new` in a class method builds the class itself.
        if (!receiver && method === "new" && from) {
          const type = enclosingClass(from);
          if (type) x.call(from, { kind: "name", name: type.name }, n, "new");
          continue;
        }
        x.call(from, rubyCallee(n), n);
      } else if (
        n.type === "identifier" &&
        STATEMENT.test(n.parent?.type ?? "") &&
        !from?.locals.has(n.text)
      ) {
        // A bare `audit` on its own line calls a method (it would be a local if assigned).
        x.call(from, { kind: "name", name: n.text }, n);
      } else if (from && n.type === "assignment") {
        const left = field(n, "left");
        const right = field(n, "right");
        if (left?.type === "identifier" && !from.locals.has(left.text)) {
          from.locals.set(left.text, { init: rubyExpr(right) });
        } else if (left?.type === "instance_variable") {
          // `@db = Db.new`: instance variables become the class's properties.
          const type = enclosingClass(from);
          const name = left.text.slice(1);
          if (type && !type.members.some((m) => m.name === name)) {
            x.declare(
              { kind: "property", name, node: n, exported: false, meta: { init: rubyExpr(right) } },
              type,
            );
          }
        }
      }
    }
  };

  const enclosingClass = (decl: Decl | undefined): Decl | undefined => {
    for (let d = decl; d; d = d.parent) if (d.kind === "class") return d;
    return undefined;
  };

  /** Statements of a body: definitions, mixins, attributes, specs, routes and other code. */
  const visit = (
    body: SyntaxNode | null,
    parent: Decl | undefined,
    specPath: string[],
    routes: { prefix: string; module: string[] },
  ): void => {
    for (const node of body ? named(body) : []) {
      const doc = docComment(node);
      switch (node.type) {
        case "module":
        case "class": {
          const type = constant(field(node, "name"));
          const name = type?.at(-1) ?? "";
          const qualifiedName = [...(parent ? [parent.qualifiedName] : []), ...(type ?? [])].join(
            ".",
          );
          const decl = x.declare(
            {
              kind: "class",
              name,
              qualifiedName,
              node,
              exported: true,
              ...(doc ? { doc } : {}),
              signature: oneLine(node.text.split("\n")[0] ?? ""),
              ...(node.type === "module" ? { meta: { module: true } } : {}),
            },
            parent,
          );
          const superNode = field(node, "superclass");
          const superclass =
            superNode &&
            constant(named(superNode).find((c) => /constant|scope_resolution/.test(c.type)));
          if (superclass) decl.bases.push({ type: superclass, relation: "extends" });
          visit(
            field(node, "body") ?? childOf(node, "body_statement") ?? null,
            decl,
            specPath,
            routes,
          );
          break;
        }
        case "method":
        case "singleton_method": {
          const name = field(node, "name")?.text ?? "";
          const inClass = parent?.kind === "class";
          const minitest = inClass && /^test_/.test(name) && x.model.isTest;
          const decl = x.declare(
            {
              kind: minitest ? "test" : inClass ? "method" : "function",
              name,
              node,
              exported: true,
              signature: oneLine(`${name}${field(node, "parameters")?.text ?? ""}`),
              ...(node.type === "singleton_method" ? { static: true } : {}),
              ...(doc ? { doc } : {}),
              ...(name === "initialize" ? { meta: { ctor: true } } : {}),
            },
            parent,
          );
          const params = field(node, "parameters");
          const names = params
            ? named(params)
                .map((p) =>
                  p.type === "identifier" ? p.text : (childOf(p, "identifier")?.text ?? ""),
                )
                .filter(Boolean)
            : [];
          for (const p of names) decl.locals.set(p, {});
          decl.meta = { ...decl.meta, params: names };
          scan(field(node, "body") ?? node, decl);
          break;
        }
        case "call":
          call(node, parent, specPath, routes);
          break;
        default:
          scan(node, parent && parent.kind !== "class" ? parent : undefined);
      }
    }
  };

  const call = (
    node: SyntaxNode,
    parent: Decl | undefined,
    specPath: string[],
    routes: { prefix: string; module: string[] },
  ): void => {
    const method = field(node, "method")?.text ?? "";
    const receiver = field(node, "receiver");
    const args = named(field(node, "arguments") ?? node).filter((a) => a.type !== "comment");
    const block = field(node, "block");
    const blockBody = block
      ? (field(block, "body") ?? childOf(block, "body_statement", "block_body") ?? null)
      : null;
    const fullName = receiver ? `${receiver.text}.${method}` : method;

    if (!receiver && (method === "require" || method === "require_relative")) {
      const path = stringValue(args[0]);
      if (path) x.import({ path, node, form: method });
      return;
    }
    // Mixins and attributes in a class body.
    if (!receiver && parent?.kind === "class" && /^(include|extend|prepend)$/.test(method)) {
      for (const arg of args) {
        const type = constant(arg);
        if (type) parent.bases.push({ type, relation: "extends" });
      }
      return;
    }
    if (!receiver && parent?.kind === "class" && /^attr_(reader|writer|accessor)$/.test(method)) {
      for (const arg of args) {
        const name = arg.text.replace(/^:/, "");
        x.declare({ kind: "property", name, node: arg, exported: true }, parent);
      }
      return;
    }
    // RSpec: describe/context group tests; it/specify are the tests.
    if (block && (SPEC_GROUPS.has(fullName) || SPEC_GROUPS.has(method))) {
      const title = stringValue(args[0]) ?? args[0]?.text ?? "";
      visit(blockBody, parent, [...specPath, title], routes);
      return;
    }
    if (block && !receiver && SPEC_TESTS.has(method) && (specPath.length > 0 || x.model.isTest)) {
      const title = [...specPath, stringValue(args[0]) ?? ""].filter(Boolean).join(" ");
      const decl = x.declare({
        kind: "test",
        name: title,
        qualifiedName: `test:${title}`,
        node,
        exported: false,
      });
      if (blockBody) scan(blockBody, decl);
      return;
    }
    // Rails routes: namespace/scope blocks, verbs with `to:`, resources.
    if (isRoutes && !receiver) {
      if ((method === "namespace" || method === "scope") && block) {
        const name = (stringValue(args[0]) ?? args[0]?.text.replace(/^:/, "")) || "";
        const module = method === "namespace" ? [...routes.module, camel(name)] : routes.module;
        visit(blockBody, parent, specPath, { prefix: joinRoute(routes.prefix, name), module });
        return;
      }
      const verb = httpMethod(method);
      if (verb && args[0]) {
        const path = joinRoute(routes.prefix, stringValue(args[0]) ?? "");
        const to = /to:\s*["']([\w/]+)#(\w+)["']/.exec(node.text);
        x.route({
          method: verb,
          path,
          node,
          framework: "rails",
          ...(to
            ? { handler: controllerAction(routes.module, to[1] as string, to[2] as string) }
            : {}),
        });
        return;
      }
      if ((method === "resources" || method === "resource") && args[0]) {
        const name = args[0].text.replace(/^:/, "");
        const base = joinRoute(routes.prefix, name);
        const only = /only:\s*\[([^\]]*)\]/.exec(node.text)?.[1]?.match(/\w+/g);
        const actions: [string, string, string][] = [
          ["GET", base, "index"],
          ["GET", `${base}/:id`, "show"],
          ["POST", base, "create"],
          ["PATCH", `${base}/:id`, "update"],
          ["DELETE", `${base}/:id`, "destroy"],
        ];
        for (const [verbName, path, action] of actions) {
          if (only && !only.includes(action)) continue;
          x.route({
            method: verbName,
            path,
            node,
            framework: "rails",
            handler: controllerAction(routes.module, name, action),
          });
        }
        if (block)
          visit(blockBody, parent, specPath, {
            prefix: `${base}/:${name.replace(/s$/, "")}_id`,
            module: routes.module,
          });
        return;
      }
    }
    // Sinatra: get "/x" do ... end — the block is the route's code.
    const verb = !receiver && block ? httpMethod(method) : undefined;
    const path = verb ? stringValue(args[0]) : undefined;
    if (verb && path?.startsWith("/")) {
      const qualifiedName = `${verb} ${path}`;
      const decl = x.declare({
        kind: "route",
        name: qualifiedName,
        qualifiedName,
        node,
        exported: true,
        meta: { method: verb, path, framework: "sinatra" },
      });
      if (blockBody) scan(blockBody, decl);
      return;
    }
    // Any other call: the call itself, then its block's statements (DSLs such as routes.draw).
    const from = parent && parent.kind !== "class" ? parent : undefined;
    if (!block) {
      scan(node, from);
      return;
    }
    x.call(from, rubyCallee(node), node);
    for (const arg of args) scan(arg, from);
    visit(blockBody, parent, specPath, routes);
  };

  visit(tree.rootNode, undefined, [], { prefix: "", module: [] });
  return x.model;
}

const camel = (name: string): string =>
  name.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());

/** "users#show" → UsersController#show (in the routes' namespace modules). */
function controllerAction(module: string[], controller: string, action: string): Expr {
  const path = [...module, ...controller.split("/").map(camel)];
  const last = `${path.pop()}Controller`;
  const object = [...path, last].reduce<Expr | undefined>(
    (acc, name) => (acc ? { kind: "member", object: acc, name } : { kind: "name", name }),
    undefined,
  ) as Expr;
  return { kind: "member", object, name: action };
}

/** Ruby: global constants, reopened classes, require/require_relative and Rails autoloading. */
function rubyRules(): LanguageRules {
  const byPath = new Map<string, FileModel>();
  return {
    language: "rb",
    registry: "gem",
    separator: ".",
    globalTypes: true,
    openClasses: true,
    autoload: true,
    prepare(project: Project) {
      for (const file of project.files) byPath.set(file.path, file);
    },
    namespaceOf: () => "",
    resolveImport(file, imp): ImportResult {
      const path = imp.path.replace(/\.rb$/, "");
      if (imp.form === "require_relative") {
        const target = byPath.get(
          posix.normalize(posix.join(posix.dirname(file.path), `${path}.rb`)),
        );
        return { files: target ? [target] : [] };
      }
      // `require "shop/user"` from lib/, app/ or anywhere the path fits.
      for (const prefix of ["lib/", "app/", "", "app/models/", "app/services/"]) {
        const target = byPath.get(`${prefix}${path}.rb`);
        if (target) return { files: [target] };
      }
      const suffix = [...byPath.keys()].find((p) => p.endsWith(`/${path}.rb`));
      if (suffix) return { files: [byPath.get(suffix) as FileModel] };
      if (STANDARD.has(path) || STANDARD.has(path.split("/")[0] as string)) return { files: [] };
      return { files: [], external: path.split("/")[0] as string };
    },
  };
}

export const ruby: LanguageDefinition = {
  name: "ruby",
  dialects: [
    {
      language: "rb",
      extensions: /\.(rb|rake)$/,
      grammar: { package: "tree-sitter-ruby", file: "tree-sitter-ruby.wasm" },
      extract: extractRuby,
    },
  ],
  rules: rubyRules,
};
