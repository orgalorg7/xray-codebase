import type { SourceFile, SyntaxNode, Tree } from "@xray/parser";
import { annotatedRoutes, TEST_ANNOTATIONS } from "./core/annotations.js";
import { Extraction, httpMethod } from "./core/extraction.js";
import type { Annotation, Decl, Expr, FileModel, Local, TypeName } from "./core/model.js";
import type { LanguageDefinition } from "./core/plugin.js";
import type { Binding, LanguageRules } from "./core/resolve.js";
import {
  childOf,
  childrenOf,
  descendants,
  docComment,
  field,
  named,
  oneLine,
  same,
  stringValue,
  typeName,
} from "./core/syntax.js";

const TEST_FILE = /(^|\/)[^/]*\.?Tests?\/|Tests?\.cs$/;

const typeOf = (node: SyntaxNode | null | undefined): TypeName | undefined =>
  node && node.type !== "implicit_type" && node.type !== "predefined_type"
    ? typeName(node.text)
    : undefined;

/** `[Route("api/x")]`, `[HttpGet("{id}")]`, `[Fact]`. */
function attributesOf(node: SyntaxNode): Annotation[] {
  const result: Annotation[] = [];
  for (const list of childrenOf(node, "attribute_list")) {
    for (const attribute of childrenOf(list, "attribute")) {
      const name =
        (field(attribute, "name")?.text ?? "")
          .split(".")
          .pop()
          ?.replace(/Attribute$/, "") ?? "";
      const strings: string[] = [];
      const namedArgs: Record<string, string[]> = {};
      const args = childOf(attribute, "attribute_argument_list");
      for (const arg of args ? childrenOf(args, "attribute_argument") : []) {
        const key = childOf(arg, "name_equals", "name_colon");
        const value = stringValue(named(arg).find((c) => !same(c, key)));
        if (value === undefined) continue;
        if (key) namedArgs[key.text.replace(/\s*[=:]\s*$/, "")] = [value];
        else strings.push(value);
      }
      result.push({ name, strings, named: namedArgs, node: attribute });
    }
  }
  return result;
}

const modifiersOf = (node: SyntaxNode): string[] => childrenOf(node, "modifier").map((m) => m.text);

function csExpr(node: SyntaxNode | null | undefined): Expr {
  if (!node) return { kind: "unknown" };
  switch (node.type) {
    case "identifier":
      return { kind: "name", name: node.text };
    case "generic_name":
      return { kind: "name", name: childOf(node, "identifier")?.text ?? node.text };
    case "this_expression":
    case "this":
      return { kind: "this" };
    case "base_expression":
    case "base":
      return { kind: "super" };
    case "member_access_expression": {
      const name = field(node, "name");
      const object = field(node, "expression");
      const nameText =
        (name?.type === "generic_name" ? childOf(name, "identifier")?.text : name?.text) ?? "";
      // `this.X` and `base.X` keep their keyword as an anonymous child.
      if (!object) {
        return {
          kind: "member",
          object: /^base\b/.test(node.text) ? { kind: "super" } : { kind: "this" },
          name: nameText,
        };
      }
      return { kind: "member", object: csExpr(object), name: nameText };
    }
    case "qualified_name":
      return {
        kind: "member",
        object: csExpr(field(node, "qualifier")),
        name: field(node, "name")?.text ?? "",
      };
    case "invocation_expression":
      return { kind: "call", callee: csExpr(field(node, "function")) };
    case "object_creation_expression":
    case "cast_expression": {
      const type = typeOf(field(node, "type"));
      return type ? { kind: "new", type } : { kind: "unknown" };
    }
    case "parenthesized_expression":
    case "await_expression":
      return csExpr(named(node)[0]);
    default:
      return { kind: "unknown" };
  }
}

const TYPES: Record<string, Decl["kind"]> = {
  class_declaration: "class",
  struct_declaration: "class",
  record_declaration: "class",
  record_struct_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
};

function extractCSharp(tree: Tree, file: SourceFile): FileModel {
  const x = new Extraction(file, tree, TEST_FILE.test(file.path));

  const scan = (body: SyntaxNode, from: Decl | undefined): void => {
    for (const n of descendants(body)) {
      switch (n.type) {
        case "invocation_expression": {
          const fn = field(n, "function");
          x.call(from, csExpr(fn), n);
          // Minimal APIs: app.MapGet("/x", Handler).
          const name =
            fn?.type === "member_access_expression" ? field(fn, "name")?.text : undefined;
          const method = name?.startsWith("Map") ? httpMethod(name) : undefined;
          if (method) {
            // MapGet("/x", Handler), and helpers that take the handler first: MapGet(Handler, "x").
            const args = childrenOf(field(n, "arguments") ?? n, "argument").map((a) => named(a)[0]);
            const pattern = args.find((a) => stringValue(a) !== undefined);
            const path = stringValue(pattern);
            const handler = args.find(
              (a) => a && !same(a, pattern) && /identifier|member_access/.test(a.type),
            );
            if (path !== undefined) {
              x.route({
                method,
                path: path.startsWith("/") ? path : `/${path}`,
                node: n,
                framework: "aspnet",
                ...(from ? { from } : {}),
                ...(handler && /identifier|member_access/.test(handler.type)
                  ? { handler: csExpr(handler) }
                  : {}),
              });
            }
          }
          break;
        }
        case "object_creation_expression": {
          const type = typeOf(field(n, "type"));
          if (type) x.call(from, { kind: "new", type }, n, "new");
          break;
        }
        case "constructor_initializer":
          x.call(from, /^:\s*base\b/.test(n.text) ? { kind: "super" } : { kind: "this" }, n);
          break;
        case "variable_declaration": {
          if (!from) break;
          const type = field(n, "type");
          for (const declarator of childrenOf(n, "variable_declarator")) {
            const nameNode = field(declarator, "name") ?? childOf(declarator, "identifier");
            if (!nameNode) continue;
            const value = named(declarator).find((c) => !same(c, nameNode));
            const local: Local =
              type?.type === "implicit_type"
                ? { init: csExpr(value?.type === "equals_value_clause" ? named(value)[0] : value) }
                : { ...(typeOf(type) ? { type: typeOf(type) as TypeName } : {}) };
            from.locals.set(nameNode.text, local);
          }
          break;
        }
        case "foreach_statement": {
          const name = field(n, "left")?.text;
          const type = typeOf(field(n, "type"));
          if (from && name && type) from.locals.set(name, { type });
          break;
        }
      }
    }
  };

  const params = (decl: Decl, list: SyntaxNode | null): void => {
    const names: string[] = [];
    for (const p of list ? childrenOf(list, "parameter") : []) {
      const name = field(p, "name")?.text;
      const type = typeOf(field(p, "type"));
      if (!name) continue;
      decl.locals.set(name, type ? { type } : {});
      names.push(name);
    }
    decl.meta = { ...decl.meta, params: names };
  };

  const visitType = (node: SyntaxNode, parent: Decl | undefined): void => {
    const name = field(node, "name")?.text ?? "";
    const modifiers = modifiersOf(node);
    const doc = docComment(childOf(node, "attribute_list") ?? node) ?? docComment(node);
    const decl = x.declare(
      {
        kind: TYPES[node.type] ?? "class",
        name,
        node,
        exported:
          modifiers.includes("public") ||
          modifiers.includes("protected") ||
          parent?.kind === "interface",
        annotations: attributesOf(node),
        ...(doc ? { doc } : {}),
        signature: oneLine(
          `${node.type.replace(/_declaration$/, "").replace("_", " ")} ${name}${childOf(node, "base_list") ? ` ${childOf(node, "base_list")?.text}` : ""}`,
        ),
        ...(modifiers.includes("static") ? { static: true } : {}),
      },
      parent,
    );
    const bases = childOf(node, "base_list");
    for (const base of bases ? named(bases) : []) {
      const type = typeOf(base.type === "primary_constructor_base_type" ? named(base)[0] : base);
      if (type)
        decl.bases.push({
          type,
          relation: node.type === "interface_declaration" ? "extends" : "unknown",
        });
    }
    // Positional records: their parameters are properties.
    const positional = node.type.startsWith("record") ? childOf(node, "parameter_list") : undefined;
    for (const p of positional ? childrenOf(positional, "parameter") : []) {
      const n = field(p, "name")?.text;
      const type = typeOf(field(p, "type"));
      if (n)
        x.declare(
          { kind: "property", name: n, node: p, exported: true, ...(type ? { type } : {}) },
          decl,
        );
    }
    const body =
      field(node, "body") ?? childOf(node, "declaration_list", "enum_member_declaration_list");
    for (const member of body ? named(body) : []) visitMember(member, decl);
  };

  const visitMember = (node: SyntaxNode, type: Decl): void => {
    if (TYPES[node.type]) {
      visitType(node, type);
      return;
    }
    const modifiers = modifiersOf(node);
    const exported =
      type.kind === "interface" || modifiers.includes("public") || modifiers.includes("protected");
    const doc = docComment(childOf(node, "attribute_list") ?? node) ?? docComment(node);
    switch (node.type) {
      case "enum_member_declaration": {
        const name = field(node, "name")?.text ?? "";
        x.declare(
          { kind: "property", name, node, exported: type.exported, type: [type.name] },
          type,
        );
        return;
      }
      case "field_declaration":
      case "event_field_declaration": {
        const declaration = childOf(node, "variable_declaration");
        const fieldType = typeOf(declaration && field(declaration, "type"));
        for (const declarator of declaration
          ? childrenOf(declaration, "variable_declarator")
          : []) {
          const name =
            field(declarator, "name")?.text ?? childOf(declarator, "identifier")?.text ?? "";
          const decl = x.declare(
            {
              kind: "property",
              name,
              node,
              exported,
              static: modifiers.includes("static"),
              ...(fieldType ? { type: fieldType } : {}),
              ...(doc ? { doc } : {}),
            },
            type,
          );
          scan(declarator, decl);
        }
        return;
      }
      case "property_declaration": {
        const name = field(node, "name")?.text ?? "";
        const propertyType = typeOf(field(node, "type"));
        const decl = x.declare(
          {
            kind: "property",
            name,
            node,
            exported,
            static: modifiers.includes("static"),
            ...(propertyType ? { type: propertyType } : {}),
            ...(doc ? { doc } : {}),
          },
          type,
        );
        scan(node, decl);
        return;
      }
      case "method_declaration":
      case "constructor_declaration": {
        const isConstructor = node.type === "constructor_declaration";
        const name = field(node, "name")?.text ?? type.name;
        const annotations = attributesOf(node);
        const isStatic = modifiers.includes("static");
        const main = name === "Main" && isStatic;
        const test = annotations.some((a) => TEST_ANNOTATIONS.has(a.name));
        const returns = typeOf(field(node, "returns") ?? field(node, "type"));
        const decl = x.declare(
          {
            kind: test ? "test" : "method",
            name,
            node,
            exported: exported || main,
            static: isStatic,
            annotations,
            signature: oneLine(
              `${field(node, "returns")?.text ?? field(node, "type")?.text ?? ""} ${name}${field(node, "parameters")?.text ?? "()"}`,
            ),
            ...(returns && returns[0] !== "void" && returns[0] !== "Task" ? { type: returns } : {}),
            ...(doc ? { doc } : {}),
            ...(isConstructor ? { meta: { ctor: true } } : main ? { meta: { entry: "main" } } : {}),
          },
          type,
        );
        params(decl, field(node, "parameters"));
        scan(node, decl);
        for (const route of annotatedRoutes(type.annotations, annotations, type.name, name)) {
          x.route({ ...route, node, handler: decl });
        }
        return;
      }
    }
  };

  const visitTop = (node: SyntaxNode): void => {
    switch (node.type) {
      case "using_directive": {
        const alias = field(node, "name")?.text;
        const target = named(node).find(
          (c) => !same(c, field(node, "name")) && /name|identifier/.test(c.type),
        );
        x.import({
          path: target?.text ?? "",
          node,
          ...(alias ? { alias } : { wildcard: true }),
          ...(/\busing\s+static\b/.test(node.text) ? { form: "static" } : {}),
        });
        return;
      }
      case "namespace_declaration":
      case "file_scoped_namespace_declaration": {
        x.model.namespace ||= field(node, "name")?.text ?? "";
        const body = field(node, "body");
        for (const child of body ? named(body) : []) visitTop(child);
        return;
      }
      case "global_statement":
        // Top-level statements (Program.cs): calls and minimal API routes belong to the module.
        scan(node, undefined);
        return;
      default:
        if (TYPES[node.type]) visitType(node, undefined);
    }
  };
  for (const node of named(tree.rootNode)) visitTop(node);
  return x.model;
}

/** C#: namespaces (and their parents), `using`, `using static` and aliases. */
function csharpRules(): LanguageRules {
  return {
    language: "cs",
    registry: "nuget",
    separator: ".",
    namespaceOf: (file) => file.namespace,
    childNamespace: (key, name, project) => {
      const child = key ? `${key}.${name}` : name;
      return project.namespaces.has(child) ? child : undefined;
    },
    implicitNamespaces(file) {
      const parts = file.namespace.split(".");
      return parts
        .slice(0, -1)
        .map((_, i) => parts.slice(0, i + 1).join("."))
        .reverse()
        .concat("");
    },
    resolveImport(_file, imp, project) {
      const path = imp.path;
      if (imp.form === "static") {
        const segments = path.split(".");
        const type = project.inNamespace(
          segments.slice(0, -1).join("."),
          segments.at(-1) as string,
        )[0];
        if (type) {
          const bindings = project
            .membersOf(type)
            .map((m): [string, Binding] => [m.name, { kind: "decls", decls: [m] }]);
          return { files: [project.fileOf.get(type) as FileModel], bindings };
        }
      } else if (project.namespaces.has(path)) {
        const files = project.filesByNamespace.get(path) ?? [];
        return imp.alias
          ? { files, bindings: [[imp.alias, { kind: "namespace", key: path }]] }
          : { files, open: [path] };
      } else if (imp.alias) {
        const segments = path.split(".");
        const type = project.inNamespace(
          segments.slice(0, -1).join("."),
          segments.at(-1) as string,
        )[0];
        if (type)
          return {
            files: [project.fileOf.get(type) as FileModel],
            bindings: [[imp.alias, { kind: "decls", decls: [type] }]],
          };
      }
      if (/^(System|Microsoft\.(Extensions|CSharp|Win32|VisualBasic))(\.|$)/.test(path))
        return { files: [] };
      return { files: [], external: path.split(".").slice(0, 2).join(".") };
    },
  };
}

export const csharp: LanguageDefinition = {
  name: "csharp",
  dialects: [
    {
      language: "cs",
      extensions: /\.cs$/,
      grammar: { package: "tree-sitter-c-sharp", file: "tree-sitter-c_sharp.wasm" },
      extract: extractCSharp,
    },
  ],
  rules: csharpRules,
};
