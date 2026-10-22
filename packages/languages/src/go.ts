import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceFile, SyntaxNode, Tree } from "@xray/parser";
import { Extraction, httpMethod } from "./core/extraction.js";
import { type Decl, type Expr, type FileModel, type TypeName, typeExpr } from "./core/model.js";
import type { LanguageDefinition } from "./core/plugin.js";
import type { LanguageRules, Project } from "./core/resolve.js";
import {
  childOf,
  childrenOf,
  descendants,
  docComment,
  field,
  fields,
  named,
  oneLine,
} from "./core/syntax.js";

const exported = (name: string) => /^\p{Lu}/u.test(name);

/** A Go string literal's value: "…" or `…`. */
const goString = (node: SyntaxNode | undefined): string | undefined =>
  node && /string_literal$/.test(node.type) ? node.text.slice(1, -1) : undefined;

/** `*m.User`, `[]Repo`, `Repo[T]` → the type's name segments. */
function goType(node: SyntaxNode | null): TypeName | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "pointer_type":
    case "parenthesized_type":
      return goType(named(node)[0] ?? null);
    case "generic_type":
      return goType(field(node, "type"));
    case "qualified_type":
      return [field(node, "package")?.text ?? "", field(node, "name")?.text ?? ""];
    case "type_identifier":
      return [node.text];
    default:
      return undefined;
  }
}

function goExpr(node: SyntaxNode | null): Expr {
  if (!node) return { kind: "unknown" };
  switch (node.type) {
    case "identifier":
    case "package_identifier":
    case "type_identifier":
      return { kind: "name", name: node.text };
    case "selector_expression":
      return {
        kind: "member",
        object: goExpr(field(node, "operand")),
        name: field(node, "field")?.text ?? "",
      };
    case "call_expression":
      return { kind: "call", callee: goExpr(field(node, "function")) };
    case "composite_literal": {
      const type = goType(field(node, "type"));
      return type ? { kind: "new", type } : { kind: "unknown" };
    }
    case "unary_expression":
      return goExpr(field(node, "operand"));
    case "parenthesized_expression":
      return goExpr(named(node)[0] ?? null);
    case "index_expression":
    case "generic_type":
      return goExpr(field(node, "operand") ?? field(node, "type"));
    default:
      return { kind: "unknown" };
  }
}

const signatureOf = (node: SyntaxNode): string =>
  oneLine(
    `${field(node, "parameters")?.text ?? "()"}${field(node, "result") ? ` ${field(node, "result")?.text}` : ""}`,
  );

/** Records parameters as locals, and their names in `meta.params`. */
function addParams(decl: Decl, list: SyntaxNode | null): void {
  const params: string[] = [];
  for (const param of list
    ? childrenOf(list, "parameter_declaration", "variadic_parameter_declaration")
    : []) {
    const type = goType(field(param, "type"));
    for (const name of fields(param, "name")) {
      decl.locals.set(name.text, type ? { type } : {});
      params.push(name.text);
    }
  }
  decl.meta = { ...decl.meta, params: [...((decl.meta?.params as string[]) ?? []), ...params] };
}

function extractGo(tree: Tree, file: SourceFile): FileModel {
  const x = new Extraction(file, tree, /_test\.go$/.test(file.path));
  const root = tree.rootNode;
  x.model.namespace = childOf(root, "package_clause")?.namedChildren[0]?.text ?? "";
  const isMain = x.model.namespace === "main";

  /** Calls, constructions and locals inside a function body (or initializer). */
  const scan = (node: SyntaxNode, from: Decl | undefined): void => {
    for (const n of descendants(node)) {
      if (n.type === "call_expression") {
        const fn = field(n, "function");
        x.call(from, goExpr(fn), n);
        if (fn?.type === "selector_expression") route(n, field(fn, "field")?.text ?? "", from);
      } else if (n.type === "composite_literal") {
        const type = goType(field(n, "type"));
        if (type) x.call(from, typeExpr(type), n, "new");
      } else if (from && n.type === "short_var_declaration") {
        const left = named(field(n, "left") ?? n);
        const right = named(field(n, "right") ?? n);
        left.forEach((name, i) => {
          if (name.type !== "identifier" || from.locals.has(name.text)) return;
          // `c, err := f()`: the first variable takes the call's first result.
          const value =
            left.length === right.length
              ? right[i]
              : i === 0 && right.length === 1
                ? right[0]
                : undefined;
          from.locals.set(name.text, value ? { init: goExpr(value) } : {});
        });
      } else if (from && n.type === "identifier" && n.text !== "_") {
        // Uses of package-level variables: writes when assigned, incremented or mutated through.
        x.access(from, n.text, n, goWrites(n));
      } else if (from && n.type === "func_literal") {
        // Parameters of inline functions (handlers, middleware) are visible in their body.
        for (const param of childrenOf(field(n, "parameters") ?? n, "parameter_declaration")) {
          const type = goType(field(param, "type"));
          for (const name of fields(param, "name")) if (type) from.locals.set(name.text, { type });
        }
      } else if (from && n.type === "var_spec") {
        const type = goType(field(n, "type"));
        const values = named(field(n, "value") ?? n);
        fields(n, "name").forEach((name, i) => {
          const value = values[i];
          from.locals.set(name.text, type ? { type } : value ? { init: goExpr(value) } : {});
        });
      }
    }
  };

  /** http.HandleFunc("/x", h), mux.HandleFunc("GET /x", h), r.GET("/x", h), r.Get("/x", h). */
  const route = (call: SyntaxNode, name: string, from: Decl | undefined): void => {
    const args = named(field(call, "arguments") ?? call).filter((a) => a.type !== "comment");
    const pattern = goString(args[0]);
    if (!pattern) return;
    let method: string | undefined;
    let path: string | undefined;
    if (name === "Handle" || name === "HandleFunc") {
      const match = /^(?:([A-Z]+) +)?(\/\S*)$/.exec(pattern);
      method = match?.[1] ?? "ANY";
      path = match?.[2];
    } else if (pattern.startsWith("/")) {
      method = httpMethod(name) ?? (name === "Any" ? "ANY" : undefined);
      path = pattern;
    }
    if (!method || !path) return;
    const handler = args[1];
    x.route({
      method,
      path,
      node: call,
      framework: "go",
      ...(from ? { from } : {}),
      ...(handler && /identifier|selector_expression/.test(handler.type)
        ? { handler: goExpr(handler) }
        : {}),
    });
  };

  for (const node of named(root)) {
    switch (node.type) {
      case "import_declaration": {
        for (const spec of [...descendants(node)].filter((n) => n.type === "import_spec")) {
          const path = field(spec, "path");
          const alias = field(spec, "name")?.text;
          x.import({
            path: path?.text.slice(1, -1) ?? "",
            ...(alias === "." ? { wildcard: true } : alias ? { alias } : {}),
            node: spec,
          });
        }
        break;
      }
      case "type_declaration": {
        for (const spec of childrenOf(node, "type_spec", "type_alias")) {
          const name = field(spec, "name")?.text ?? "";
          const type = field(spec, "type");
          const kind =
            type?.type === "struct_type"
              ? "class"
              : type?.type === "interface_type"
                ? "interface"
                : "type-alias";
          const doc = docComment(spec) ?? docComment(node);
          const decl = x.declare({
            kind,
            name,
            node: spec,
            exported: exported(name),
            ...(doc ? { doc } : {}),
            signature: oneLine(
              `type ${name} ${kind === "type-alias" ? (type?.text ?? "") : (type?.type.replace("_type", "") ?? "")}`,
            ),
          });
          if (type?.type === "struct_type") {
            for (const f of [...descendants(type)].filter((n) => n.type === "field_declaration")) {
              const fieldType = goType(field(f, "type"));
              const names = fields(f, "name");
              // An embedded field promotes the embedded type's methods: inheritance in all but name.
              if (names.length === 0 && fieldType)
                decl.bases.push({ type: fieldType, relation: "extends" });
              for (const n of names) {
                x.declare(
                  {
                    kind: "property",
                    name: n.text,
                    node: f,
                    exported: exported(n.text),
                    ...(fieldType ? { type: fieldType } : {}),
                  },
                  decl,
                );
              }
            }
          } else if (type?.type === "interface_type") {
            for (const member of named(type)) {
              if (member.type === "method_elem") {
                const m = field(member, "name")?.text ?? "";
                const doc = docComment(member);
                x.declare(
                  {
                    kind: "method",
                    name: m,
                    node: member,
                    exported: exported(m),
                    signature: signatureOf(member),
                    ...(doc ? { doc } : {}),
                    ...(goType(field(member, "result"))
                      ? { type: goType(field(member, "result")) as TypeName }
                      : {}),
                  },
                  decl,
                );
              } else if (member.type === "type_elem") {
                const embedded = goType(named(member)[0] ?? null);
                if (embedded) decl.bases.push({ type: embedded, relation: "extends" });
              }
            }
          }
        }
        break;
      }
      case "function_declaration": {
        const name = field(node, "name")?.text ?? "";
        const test = x.model.isTest && /^(Test|Benchmark|Example|Fuzz)/.test(name);
        const doc = docComment(node);
        const result = field(node, "result");
        const decl = x.declare({
          kind: test ? "test" : "function",
          name,
          node,
          exported: exported(name) || (isMain && name === "main") || name === "init",
          signature: signatureOf(node),
          ...(doc ? { doc } : {}),
          ...(goType(result) ? { type: goType(result) as TypeName } : resultType(result)),
          ...(isMain && name === "main" ? { meta: { entry: "main" } } : {}),
        });
        addParams(decl, field(node, "parameters"));
        const body = field(node, "body");
        if (body) scan(body, decl);
        break;
      }
      case "method_declaration": {
        const name = field(node, "name")?.text ?? "";
        const receiver = childOf(field(node, "receiver") ?? node, "parameter_declaration");
        const owner = goType(receiver ? field(receiver, "type") : null);
        const doc = docComment(node);
        const result = field(node, "result");
        const decl = x.declare({
          kind: "method",
          name,
          qualifiedName: `${owner?.join(".") ?? "?"}.${name}`,
          node,
          exported: exported(name),
          signature: signatureOf(node),
          ...(owner ? { owner } : {}),
          ...(doc ? { doc } : {}),
          ...(goType(result) ? { type: goType(result) as TypeName } : resultType(result)),
        });
        const self = receiver ? field(receiver, "name")?.text : undefined;
        if (self && owner) decl.locals.set(self, { type: owner });
        addParams(decl, field(node, "parameters"));
        const body = field(node, "body");
        if (body) scan(body, decl);
        break;
      }
      case "var_declaration":
      case "const_declaration": {
        for (const spec of [...descendants(node)].filter(
          (n) => n.type === "var_spec" || n.type === "const_spec",
        )) {
          const type = goType(field(spec, "type"));
          const values = named(field(spec, "value") ?? spec).filter((v) => v.type !== "comment");
          fields(spec, "name").forEach((n, i) => {
            // `var _ Interface = (*T)(nil)` checks a type; it declares nothing.
            if (n.text === "_") return;
            const init = values[i];
            const doc = docComment(spec) ?? docComment(node);
            const decl = x.declare({
              kind: "variable",
              name: n.text,
              node: spec,
              exported: exported(n.text),
              ...(type ? { type } : {}),
              ...(doc ? { doc } : {}),
              ...(init
                ? {
                    meta: {
                      init: goExpr(init),
                      ...(node.type === "const_declaration" ? { constant: true } : {}),
                    },
                  }
                : {}),
            });
            if (init) scan(init, decl);
          });
        }
        break;
      }
    }
  }
  return x.model;
}

/**
 * Whether an identifier is written: the target of `=`/`+=`, `x++`, or the base of an assigned
 * field or element (`cfg.Debug = true`, `cache[k] = v`).
 */
function goWrites(node: SyntaxNode): boolean {
  let expr = node;
  for (let parent = expr.parent; parent; parent = expr.parent) {
    const base =
      parent.type === "selector_expression"
        ? field(parent, "operand")
        : parent.type === "index_expression"
          ? field(parent, "operand")
          : null;
    if (!base || base.id !== expr.id) break;
    expr = parent;
  }
  const parent = expr.parent;
  if (parent?.type === "inc_statement" || parent?.type === "dec_statement") return true;
  const list = parent?.type === "expression_list" ? parent : undefined;
  const statement = list?.parent;
  return statement?.type === "assignment_statement" && field(statement, "left")?.id === list?.id;
}

/** The first named result of `(T, error)`. */
function resultType(result: SyntaxNode | null): { type?: TypeName } {
  if (result?.type !== "parameter_list") return {};
  const first = childOf(result, "parameter_declaration");
  const type = goType(first ? field(first, "type") : null);
  return type ? { type } : {};
}

/** Go modules (`go.mod`) by directory, read once per analysis. */
function goRules(): LanguageRules {
  /** Module directory (repo-relative, "" for the root) → module path. */
  const modules = new Map<string, string>();
  const dirOf = (path: string) => {
    const dir = dirname(path);
    return dir === "." ? "" : dir;
  };
  let packageDirs: string[] = [];

  return {
    language: "go",
    registry: "go",
    prepare(project: Project) {
      const dirs = new Set(project.files.map((f) => dirOf(f.path)));
      packageDirs = [...dirs];
      // go.mod files at or above each package directory.
      const candidates = new Set<string>([""]);
      for (const dir of dirs) {
        const parts = dir ? dir.split("/") : [];
        for (let i = 0; i <= parts.length; i++) candidates.add(parts.slice(0, i).join("/"));
      }
      for (const dir of candidates) {
        const goMod = join(project.root, dir, "go.mod");
        if (!existsSync(goMod)) continue;
        const module = /^module\s+(\S+)/m.exec(readFileSync(goMod, "utf8"))?.[1];
        if (module) modules.set(dir, module);
      }
    },
    namespaceOf: (file) => `go:${dirOf(file.path)}`,
    resolveImport(_file, imp, project) {
      const path = imp.path;
      let dir: string | undefined;
      for (const [moduleDir, module] of modules) {
        if (path === module || path.startsWith(`${module}/`)) {
          const rest = path.slice(module.length).replace(/^\//, "");
          dir = [moduleDir, rest].filter(Boolean).join("/");
          break;
        }
      }
      // Without go.mod, the longest package directory the import path ends with.
      if (dir === undefined || !project.filesByNamespace.has(`go:${dir}`)) {
        dir = packageDirs
          .filter((d) => d && (path === d || path.endsWith(`/${d}`)))
          .sort((a, b) => b.length - a.length)[0];
      }
      const key = dir !== undefined ? `go:${dir}` : undefined;
      // A package's _test.go files are not part of what importers build against.
      const files = key ? (project.filesByNamespace.get(key) ?? []).filter((f) => !f.isTest) : [];
      if (key && files.length > 0) {
        if (imp.alias === "_") return { files };
        if (imp.wildcard) return { files, open: [key] };
        const name =
          imp.alias ??
          files.find((f) => !/_test$/.test(f.namespace))?.namespace ??
          path.split("/").pop() ??
          path;
        return { files, bindings: [[name, { kind: "namespace", key }]] };
      }
      const last = path.split("/").pop() ?? path;
      const binding: [string, { kind: "external"; name: string }][] =
        imp.alias === "_" || imp.wildcard
          ? []
          : [[imp.alias ?? last.replace(/^go-|\.v\d+$/g, ""), { kind: "external", name: path }]];
      // The standard library has no dot in its first segment.
      const first = path.split("/")[0] ?? "";
      if (!first.includes(".")) return { files: [], bindings: binding };
      const external = path
        .split("/")
        .slice(0, first === "gopkg.in" ? 2 : 3)
        .join("/");
      return { files: [], external, bindings: binding };
    },
    finish(project, emit) {
      // Go types satisfy interfaces implicitly: a struct implements every interface whose
      // methods it all has.
      const interfaces = project.files.flatMap((f) =>
        f.decls.filter((d) => d.kind === "interface"),
      );
      const structs = project.files.flatMap((f) => f.decls.filter((d) => d.kind === "class"));
      for (const iface of interfaces) {
        const required = iface.members.filter((m) => m.kind === "method").map((m) => m.name);
        if (required.length === 0) continue;
        for (const type of structs) {
          const has = new Set(project.membersOf(type).map((m) => m.name));
          if (!required.every((name) => has.has(name))) continue;
          const file = project.fileOf.get(type) as FileModel;
          emit(file, {
            source: project.idOf(type),
            target: project.idOf(iface),
            kind: "implements",
            confidence: "inferred",
            detail: "structural",
          });
          for (const name of required) {
            const method = project.membersOf(type).find((m) => m.name === name);
            const target = iface.members.find((m) => m.name === name);
            if (method && target) {
              emit(file, {
                source: project.idOf(method),
                target: project.idOf(target),
                kind: "overrides",
                confidence: "inferred",
                detail: "implements",
              });
            }
          }
        }
      }
    },
  };
}

export const go: LanguageDefinition = {
  name: "go",
  dialects: [
    {
      language: "go",
      extensions: /\.go$/,
      grammar: { package: "tree-sitter-go", file: "tree-sitter-go.wasm" },
      extract: extractGo,
    },
  ],
  rules: goRules,
};
