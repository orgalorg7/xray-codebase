import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceFile, SyntaxNode, Tree } from "@xray/parser";
import { Extraction, httpMethod } from "./core/extraction.js";
import type { Decl, Expr, FileModel, Import, TypeName } from "./core/model.js";
import { typeExpr } from "./core/model.js";
import type { LanguageDefinition } from "./core/plugin.js";
import type { ImportResult, LanguageRules, Project } from "./core/resolve.js";
import {
  childOf,
  childrenOf,
  descendants,
  docComment,
  field,
  named,
  oneLine,
  stringValue,
} from "./core/syntax.js";

/** Types whose interesting part is their first type argument. */
const WRAPPERS = new Set([
  "Option",
  "Result",
  "Box",
  "Rc",
  "Arc",
  "RefCell",
  "Cell",
  "Mutex",
  "RwLock",
  "Cow",
]);

function rustType(node: SyntaxNode | null | undefined): TypeName | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case "type_identifier":
      return [node.text];
    case "scoped_type_identifier":
    case "scoped_identifier": {
      const path =
        rustType(field(node, "path")) ??
        (field(node, "path") ? [field(node, "path")?.text ?? ""] : []);
      return [...path, field(node, "name")?.text ?? ""];
    }
    case "reference_type":
    case "pointer_type":
      return rustType(field(node, "type"));
    case "generic_type": {
      const outer = rustType(field(node, "type"));
      const last = outer?.at(-1);
      if (last && WRAPPERS.has(last)) {
        const args = field(node, "type_arguments");
        return rustType(args ? named(args)[0] : undefined);
      }
      return outer;
    }
    case "identifier":
    case "crate":
    case "self":
    case "super":
      return [node.text];
    default:
      return undefined;
  }
}

function rustExpr(node: SyntaxNode | null | undefined): Expr {
  if (!node) return { kind: "unknown" };
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      return { kind: "name", name: node.text };
    case "self":
      return { kind: "this" };
    case "crate":
    case "super":
      return { kind: "name", name: node.text };
    case "scoped_identifier":
    case "scoped_type_identifier": {
      const path = field(node, "path");
      return {
        kind: "member",
        object: path ? rustExpr(path) : { kind: "unknown" },
        name: field(node, "name")?.text ?? "",
      };
    }
    case "field_expression":
      return {
        kind: "member",
        object: rustExpr(field(node, "value")),
        name: field(node, "field")?.text ?? "",
      };
    case "call_expression":
      return { kind: "call", callee: rustExpr(field(node, "function")) };
    case "struct_expression": {
      const type = rustType(field(node, "name"));
      return type ? { kind: "new", type } : { kind: "unknown" };
    }
    case "generic_function":
      return rustExpr(field(node, "function"));
    case "reference_expression":
    case "try_expression":
    case "await_expression":
    case "parenthesized_expression":
      return rustExpr(field(node, "value") ?? named(node)[0]);
    default:
      return { kind: "unknown" };
  }
}

/** `use a::{b, c as d}` → `a::b`, `a::c` (as d). */
function useTree(
  node: SyntaxNode | null,
  prefix: string[],
): { path: string[]; alias?: string; wildcard?: boolean }[] {
  if (!node) return [];
  const segments = (n: SyntaxNode | null): string[] =>
    !n
      ? []
      : n.type === "scoped_identifier"
        ? [...segments(field(n, "path")), field(n, "name")?.text ?? ""]
        : [n.text];
  switch (node.type) {
    case "scoped_use_list":
      return useTree(field(node, "list"), [...prefix, ...segments(field(node, "path"))]);
    case "use_list":
      return named(node).flatMap((item) => useTree(item, prefix));
    case "use_as_clause":
      return [
        {
          path: [...prefix, ...segments(field(node, "path"))],
          alias: field(node, "alias")?.text ?? "",
        },
      ];
    case "use_wildcard":
      return [{ path: [...prefix, ...segments(named(node)[0] ?? null)], wildcard: true }];
    default:
      return [{ path: [...prefix, ...segments(node)] }];
  }
}

const ROUTE_ATTRIBUTES = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

function extractRust(tree: Tree, file: SourceFile): FileModel {
  const x = new Extraction(file, tree, /(^|\/)tests\//.test(file.path));

  const scan = (body: SyntaxNode, from: Decl | undefined): void => {
    for (const n of descendants(
      body,
      (d) => d.type === "function_item" || d.type === "impl_item",
    )) {
      if (n.type === "call_expression") {
        const fn = field(n, "function");
        x.call(from, rustExpr(fn), n);
        // axum: Router::new().route("/users", get(list).post(create)).
        if (fn?.type === "field_expression" && field(fn, "field")?.text === "route") {
          const args = named(field(n, "arguments") ?? n);
          const path = stringValue(args[0]);
          if (path?.startsWith("/")) {
            for (let handler = args[1]; handler?.type === "call_expression"; ) {
              const inner = field(handler, "function");
              const verb =
                inner?.type === "field_expression" ? field(inner, "field")?.text : inner?.text;
              const target = named(field(handler, "arguments") ?? handler)[0];
              const method = verb ? httpMethod(verb) : undefined;
              if (method)
                x.route({
                  method,
                  path,
                  node: n,
                  framework: "axum",
                  ...(from ? { from } : {}),
                  ...(target ? { handler: rustExpr(target) } : {}),
                });
              handler =
                inner?.type === "field_expression"
                  ? (field(inner, "value") ?? undefined)
                  : undefined;
            }
          }
        }
      } else if (n.type === "struct_expression") {
        const type = rustType(field(n, "name"));
        if (type) x.call(from, typeExpr(type), n, "new");
      } else if (from && n.type === "let_declaration") {
        const pattern = field(n, "pattern");
        if (pattern?.type !== "identifier" && pattern?.type !== "mut_pattern") continue;
        const name =
          pattern.type === "identifier"
            ? pattern.text
            : (childOf(pattern, "identifier")?.text ?? "");
        const type = rustType(field(n, "type"));
        const value = field(n, "value");
        from.locals.set(name, type ? { type } : value ? { init: rustExpr(value) } : {});
      }
    }
  };

  const attributesBefore = (node: SyntaxNode): string[] => {
    const result: string[] = [];
    for (
      let prev = node.previousNamedSibling;
      prev && /attribute_item|comment/.test(prev.type);
      prev = prev.previousNamedSibling
    ) {
      if (prev.type === "attribute_item") result.push(prev.text);
    }
    return result;
  };

  const fn = (
    node: SyntaxNode,
    owner: TypeName | undefined,
    prefix: string,
    inTest: boolean,
  ): Decl => {
    const name = field(node, "name")?.text ?? "";
    const attributes = attributesBefore(node);
    const test = attributes.some((a) => /^#\[(\w+::)?test\b/.test(a));
    const params = field(node, "parameters");
    const hasSelf = !!(params && childOf(params, "self_parameter"));
    const doc =
      docComment(attributes.length > 0 ? (node.previousNamedSibling ?? node) : node) ??
      docComment(node);
    const returns = rustType(field(node, "return_type"));
    const decl = x.declare({
      kind: test ? "test" : owner ? "method" : "function",
      name,
      qualifiedName: `${prefix}${owner ? `${owner.at(-1)}.` : ""}${name}`,
      node,
      exported:
        /^pub\b/.test(childOf(node, "visibility_modifier")?.text ?? "") ||
        (name === "main" && !owner),
      signature: oneLine(
        `${params?.text ?? "()"}${field(node, "return_type") ? ` -> ${field(node, "return_type")?.text}` : ""}`,
      ),
      ...(owner ? { owner, static: !hasSelf } : {}),
      ...(returns ? { type: returns } : {}),
      ...(doc ? { doc } : {}),
      ...(name === "main" && !owner && !inTest ? { meta: { entry: "main" } } : {}),
    });
    const names: string[] = [];
    for (const p of params ? childrenOf(params, "parameter") : []) {
      const pattern = field(p, "pattern");
      const type = rustType(field(p, "type"));
      if (pattern?.type !== "identifier") continue;
      decl.locals.set(pattern.text, type ? { type } : {});
      names.push(pattern.text);
    }
    decl.meta = { ...decl.meta, params: names };
    // actix-web and rocket: #[get("/users/{id}")]
    for (const attribute of attributes) {
      const match = /^#\[(?:\w+::)?(\w+)\(\s*"([^"]*)"/.exec(attribute);
      if (match && ROUTE_ATTRIBUTES.has(match[1] as string)) {
        x.route({
          method: (match[1] as string).toUpperCase(),
          path: match[2] as string,
          node,
          framework: "actix",
          handler: decl,
        });
      }
    }
    const body = field(node, "body");
    if (body) scan(body, decl);
    return decl;
  };

  const visit = (items: SyntaxNode, prefix: string, inTest: boolean): void => {
    for (const node of named(items)) {
      const visibility = childOf(node, "visibility_modifier")?.text ?? "";
      const exported = /^pub\b/.test(visibility);
      const doc = docComment(node);
      const name = field(node, "name")?.text ?? "";
      switch (node.type) {
        case "use_declaration":
          for (const use of useTree(field(node, "argument"), [])) {
            x.import({
              path: use.path.join("::"),
              node,
              ...(use.alias ? { alias: use.alias } : {}),
              ...(use.wildcard ? { wildcard: true } : {}),
              ...(prefix ? { form: "inner" } : {}),
              ...(/^pub\b/.test(childOf(node, "visibility_modifier")?.text ?? "")
                ? { exported: true }
                : {}),
            });
          }
          break;
        case "mod_item": {
          const body = field(node, "body");
          if (body)
            visit(
              body,
              `${prefix}${name}.`,
              inTest || /cfg\(test\)/.test(node.previousNamedSibling?.text ?? ""),
            );
          else x.model.modules.push(name);
          break;
        }
        case "struct_item":
        case "union_item": {
          const decl = x.declare({
            kind: "class",
            name,
            qualifiedName: prefix + name,
            node,
            exported,
            ...(doc ? { doc } : {}),
            signature: oneLine(`struct ${name}`),
          });
          const body = field(node, "body");
          for (const f of body ? childrenOf(body, "field_declaration") : []) {
            const fieldName = field(f, "name")?.text ?? "";
            const type = rustType(field(f, "type"));
            x.declare(
              {
                kind: "property",
                name: fieldName,
                node: f,
                exported: !!childOf(f, "visibility_modifier"),
                ...(type ? { type } : {}),
              },
              decl,
            );
          }
          break;
        }
        case "enum_item": {
          const decl = x.declare({
            kind: "enum",
            name,
            qualifiedName: prefix + name,
            node,
            exported,
            ...(doc ? { doc } : {}),
          });
          const body = field(node, "body");
          for (const variant of body ? childrenOf(body, "enum_variant") : []) {
            const variantName = field(variant, "name")?.text ?? "";
            x.declare(
              { kind: "property", name: variantName, node: variant, exported, type: [name] },
              decl,
            );
          }
          break;
        }
        case "trait_item": {
          const decl = x.declare({
            kind: "interface",
            name,
            qualifiedName: prefix + name,
            node,
            exported,
            ...(doc ? { doc } : {}),
          });
          const bounds = field(node, "bounds");
          for (const bound of bounds ? named(bounds) : []) {
            const type = rustType(bound);
            if (type) decl.bases.push({ type, relation: "extends" });
          }
          const body = field(node, "body");
          for (const item of body ? named(body) : []) {
            if (item.type === "function_signature_item" || item.type === "function_item") {
              const m = field(item, "name")?.text ?? "";
              const method = x.declare(
                {
                  kind: "method",
                  name: m,
                  node: item,
                  exported,
                  signature: oneLine(field(item, "parameters")?.text ?? "()"),
                },
                decl,
              );
              const returns = rustType(field(item, "return_type"));
              if (returns) method.type = returns;
              const fnBody = field(item, "body");
              if (fnBody) scan(fnBody, method);
            }
          }
          break;
        }
        case "type_item":
          x.declare({
            kind: "type-alias",
            name,
            qualifiedName: prefix + name,
            node,
            exported,
            signature: oneLine(node.text),
          });
          break;
        case "const_item":
        case "static_item": {
          const type = rustType(field(node, "type"));
          const value = field(node, "value");
          const decl = x.declare({
            kind: "variable",
            name,
            qualifiedName: prefix + name,
            node,
            exported,
            ...(type ? { type } : {}),
            ...(doc ? { doc } : {}),
            ...(value
              ? {
                  meta: {
                    init: rustExpr(value),
                    ...(node.type === "const_item" ? { constant: true } : {}),
                  },
                }
              : {}),
          });
          if (value) scan(value, decl);
          break;
        }
        case "function_item":
          fn(node, undefined, prefix, inTest);
          break;
        case "impl_item": {
          const type = rustType(field(node, "type"));
          const trait = rustType(field(node, "trait"));
          if (!type) break;
          if (trait) x.model.impls.push({ type, trait });
          const body = field(node, "body");
          for (const item of body ? childrenOf(body, "function_item") : [])
            fn(item, type, prefix, inTest);
          break;
        }
      }
    }
  };
  visit(tree.rootNode, "", x.model.isTest);
  return x.model;
}

/**
 * Rust's module tree, derived from paths the way Cargo lays crates out: `src/a/b.rs` is
 * `crate::a::b`, `mod.rs`, `lib.rs` and `main.rs` are their directory's module.
 */
function rustRules(): LanguageRules {
  const crateDirs = new Map<string, string>();
  /** Crate name (as code spells it) → crate directory. */
  const crateNames = new Map<string, string>();
  const keys = new Map<FileModel, string>();

  const crateDirOf = (root: string, path: string): string => {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const key = dir === "." ? "" : dir;
      const cached = crateDirs.get(key);
      if (cached !== undefined) return cached;
      const manifest = join(root, key, "Cargo.toml");
      if (existsSync(manifest)) {
        const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(
          readFileSync(manifest, "utf8").split(/^\[(?!package)/m)[0] ?? "",
        )?.[1];
        if (name) crateNames.set(name.replaceAll("-", "_"), key);
        crateDirs.set(key, key);
        return key;
      }
      if (key === "") {
        // No Cargo.toml: the directory holding src/, or the root.
        const src = path.lastIndexOf("src/");
        return src > 0 ? path.slice(0, src - 1) : "";
      }
    }
  };

  const moduleKey = (crate: string, path: string): string => {
    const rel = crate ? path.slice(crate.length + 1) : path;
    let parts: string[];
    if (rel.startsWith("src/")) {
      parts = rel.slice(4).replace(/\.rs$/, "").split("/");
      if (parts[0] === "bin" && parts.length > 1) parts = [`bin:${parts.slice(1).join("/")}`];
      else if (["lib", "main", "mod"].includes(parts.at(-1) as string)) parts.pop();
    } else parts = [`file:${rel.replace(/\.rs$/, "")}`];
    return `${crate}|${parts.join("::")}`;
  };

  const parent = (key: string): string => key.replace(/(::)?[^:|]+$/, "");
  const child = (key: string, name: string): string =>
    key.endsWith("|") ? `${key}${name}` : `${key}::${name}`;
  const rootOf = (key: string): string => `${key.split("|")[0]}|`;

  /** An item a module re-exports with `pub use` (`pub use store::Repo;` in lib.rs). */
  const reexported = (
    project: Project,
    key: string,
    name: string,
    depth: number,
  ): Decl | undefined => {
    if (depth > 8) return undefined;
    for (const file of project.filesByNamespace.get(key) ?? []) {
      for (const imp of file.imports) {
        if (!imp.exported || (imp.alias ?? imp.path.split("::").at(-1)) !== name) continue;
        const found = resolve(file, imp, project, depth + 1).bindings?.[0]?.[1];
        if (found?.kind === "decls") return found.decls[0];
      }
    }
    return undefined;
  };

  const rules: LanguageRules = {
    language: "rs",
    registry: "cargo",
    separator: "::",
    prepare(project: Project) {
      for (const file of project.files)
        keys.set(file, moduleKey(crateDirOf(project.root, file.path), file.path));
      for (const file of project.files) {
        const key = keys.get(file) as string;
        const scope = project.scopeOf(file);
        scope.bindings.set("crate", { kind: "namespace", key: rootOf(key) });
        scope.bindings.set("super", { kind: "namespace", key: parent(key) });
        for (const name of file.modules)
          scope.bindings.set(name, { kind: "namespace", key: child(key, name) });
        // Workspace crates can be named in paths without a `use`.
        for (const [crate, dir] of crateNames) {
          if (!scope.bindings.has(crate))
            scope.bindings.set(crate, { kind: "namespace", key: `${dir}|` });
        }
      }
    },
    namespaceOf: (file) => keys.get(file) ?? "",
    childNamespace: (key, name, project) =>
      project.namespaces.has(child(key, name)) ? child(key, name) : undefined,
    resolveImport: (file, imp, project) => resolve(file, imp, project, 0),
  };

  function resolve(file: FileModel, imp: Import, project: Project, depth: number): ImportResult {
    const segments = imp.path.split("::");
    const own = keys.get(file) as string;
    let key: string | undefined;
    let i = 0;
    const first = segments[0] ?? "";
    if (first === "crate") [key, i] = [rootOf(own), 1];
    else if (first === "self") [key, i] = [own, 1];
    else if (first === "super") {
      // Inside an inline `mod tests { use super::*; }`, the first super is the file's module.
      key = own;
      for (; segments[i] === "super"; i++) {
        if (i > 0 || imp.form !== "inner") key = parent(key);
      }
    } else if (crateNames.has(first)) [key, i] = [`${crateNames.get(first)}|`, 1];
    else if (project.namespaces.has(child(own, first))) key = own;
    else if (project.namespaces.has(child(rootOf(own), first))) key = rootOf(own);
    if (key === undefined) {
      const name = imp.alias ?? segments.at(-1) ?? first;
      const bindings: [string, { kind: "external"; name: string }][] = imp.wildcard
        ? []
        : [[name, { kind: "external", name: imp.path }]];
      if (/^(std|core|alloc|proc_macro|test)$/.test(first)) return { files: [], bindings };
      return { files: [], external: first, bindings };
    }
    // Walk modules, then items and their members.
    let decl: Decl | undefined;
    for (; i < segments.length; i++) {
      const segment = segments[i] as string;
      if (!decl && project.namespaces.has(child(key, segment))) {
        key = child(key, segment);
        continue;
      }
      decl = decl
        ? project.membersOf(decl).find((m) => m.name === segment)
        : (project.inNamespace(key, segment)[0] ?? reexported(project, key, segment, depth));
      if (!decl) return { files: [] };
    }
    if (decl) {
      const target = project.fileOf.get(decl) as FileModel;
      if (imp.wildcard) {
        return {
          files: [target],
          bindings: project.membersOf(decl).map((m) => [m.name, { kind: "decls", decls: [m] }]),
        };
      }
      return {
        files: [target],
        bindings: [[imp.alias ?? decl.name, { kind: "decls", decls: [decl] }]],
      };
    }
    const files = project.filesByNamespace.get(key) ?? [];
    if (imp.wildcard) return { files, open: [key] };
    return {
      files,
      bindings: [[imp.alias ?? (segments.at(-1) as string), { kind: "namespace", key }]],
    };
  }
  return rules;
}

export const rust: LanguageDefinition = {
  name: "rust",
  dialects: [
    {
      language: "rs",
      extensions: /\.rs$/,
      grammar: { package: "tree-sitter-rust", file: "tree-sitter-rust.wasm" },
      extract: extractRust,
    },
  ],
  rules: rustRules,
};
