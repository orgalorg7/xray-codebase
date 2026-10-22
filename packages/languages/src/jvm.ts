import type { SourceFile, SyntaxNode, Tree } from "@xray/parser";
import { annotatedRoutes, TEST_ANNOTATIONS } from "./core/annotations.js";
import { Extraction } from "./core/extraction.js";
import type { Annotation, Decl, Expr, FileModel, Local, TypeName } from "./core/model.js";
import type { LanguageDefinition } from "./core/plugin.js";
import type { Binding, ImportResult, LanguageRules, Project } from "./core/resolve.js";
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

const TEST_FILE = /(^|\/)src\/test\/|(Test|Tests|IT|Spec)\.(java|kt)$/;

const typeOf = (node: SyntaxNode | null | undefined): TypeName | undefined =>
  node ? typeName(node.text) : undefined;

/** Annotations among a declaration's modifiers (Java and Kotlin shapes). */
function annotationsOf(modifiers: SyntaxNode | undefined): Annotation[] {
  if (!modifiers) return [];
  const result: Annotation[] = [];
  for (const node of named(modifiers)) {
    if (!/annotation/.test(node.type)) continue;
    // Java: name + annotation_argument_list. Kotlin: user_type or constructor_invocation.
    const call = childOf(node, "constructor_invocation");
    const nameNode = field(node, "name") ?? childOf(call ?? node, "user_type") ?? named(node)[0];
    const name = nameNode?.text.split(".").pop() ?? "";
    const args = field(node, "arguments") ?? childOf(call ?? node, "value_arguments");
    const strings: string[] = [];
    const namedArgs: Record<string, string[]> = {};
    for (const arg of args ? named(args) : []) {
      if (arg.type === "element_value_pair") {
        const key = field(arg, "key")?.text ?? "";
        const value = field(arg, "value");
        namedArgs[key] = value
          ? [value, ...descendants(value)]
              .map(
                (v) =>
                  stringValue(v) ?? (/identifier|field_access/.test(v.type) ? v.text : undefined),
              )
              .filter((v): v is string => v !== undefined)
          : [];
      } else {
        const literal = arg.type === "value_argument" ? named(arg)[0] : arg;
        const value = stringValue(literal);
        if (value !== undefined) strings.push(value);
      }
    }
    result.push({ name, strings, named: namedArgs, node });
  }
  return result;
}

const hasModifier = (modifiers: SyntaxNode | undefined, ...words: string[]): boolean =>
  !!modifiers && words.some((w) => new RegExp(`\\b${w}\\b`).test(modifiers.text));

// ---- Java ---------------------------------------------------------------------------------

function javaExpr(node: SyntaxNode | null | undefined): Expr {
  if (!node) return { kind: "unknown" };
  switch (node.type) {
    case "identifier":
    case "type_identifier":
      return { kind: "name", name: node.text };
    case "this":
      return { kind: "this" };
    case "super":
      return { kind: "super" };
    case "field_access":
      return {
        kind: "member",
        object: javaExpr(field(node, "object")),
        name: field(node, "field")?.text ?? "",
      };
    case "scoped_identifier":
    case "scoped_type_identifier":
      return {
        kind: "member",
        object: javaExpr(field(node, "scope") ?? named(node)[0]),
        name: field(node, "name")?.text ?? named(node).at(-1)?.text ?? "",
      };
    case "method_invocation":
      return { kind: "call", callee: javaCallee(node) };
    case "object_creation_expression":
    case "cast_expression": {
      const type = typeOf(field(node, "type"));
      return type ? { kind: "new", type } : { kind: "unknown" };
    }
    case "parenthesized_expression":
      return javaExpr(named(node)[0]);
    default:
      return { kind: "unknown" };
  }
}

function javaCallee(invocation: SyntaxNode): Expr {
  const name = field(invocation, "name")?.text ?? "";
  const object = field(invocation, "object");
  return object ? { kind: "member", object: javaExpr(object), name } : { kind: "name", name };
}

function extractJava(tree: Tree, file: SourceFile): FileModel {
  const x = new Extraction(file, tree, TEST_FILE.test(file.path));
  const root = tree.rootNode;
  const pkg = childOf(root, "package_declaration");
  x.model.namespace = pkg ? (named(pkg).find((n) => /identifier/.test(n.type))?.text ?? "") : "";

  const scan = (body: SyntaxNode, from: Decl): void => {
    for (const n of descendants(body, (d) => d.type === "class_body")) {
      switch (n.type) {
        case "method_invocation":
          x.call(from, javaCallee(n), n);
          break;
        case "object_creation_expression": {
          const type = typeOf(field(n, "type"));
          if (type) x.call(from, { kind: "new", type }, n, "new");
          break;
        }
        case "explicit_constructor_invocation": {
          const target = field(n, "constructor");
          x.call(from, target?.type === "super" ? { kind: "super" } : { kind: "this" }, n);
          break;
        }
        case "local_variable_declaration": {
          const type = field(n, "type");
          for (const declarator of childrenOf(n, "variable_declarator")) {
            const name = field(declarator, "name")?.text;
            if (!name) continue;
            const local: Local =
              type?.text === "var"
                ? { init: javaExpr(field(declarator, "value")) }
                : { ...(typeOf(type) ? { type: typeOf(type) as TypeName } : {}) };
            from.locals.set(name, local);
          }
          break;
        }
        case "enhanced_for_statement": {
          const name = field(n, "name")?.text;
          const type = typeOf(field(n, "type"));
          if (name && type && type[0] !== "var") from.locals.set(name, { type });
          break;
        }
      }
    }
  };

  const params = (decl: Decl, list: SyntaxNode | null): void => {
    const names: string[] = [];
    for (const p of list ? childrenOf(list, "formal_parameter", "spread_parameter") : []) {
      const name = field(p, "name")?.text ?? named(p).at(-1)?.text;
      const type = typeOf(field(p, "type") ?? named(p).find((c) => /type/.test(c.type)));
      if (!name) continue;
      decl.locals.set(name, type ? { type } : {});
      names.push(name);
    }
    decl.meta = { ...decl.meta, params: names };
  };

  const KIND: Record<string, Decl["kind"]> = {
    class_declaration: "class",
    record_declaration: "class",
    interface_declaration: "interface",
    annotation_type_declaration: "interface",
    enum_declaration: "enum",
  };

  const visitType = (node: SyntaxNode, parent: Decl | undefined): void => {
    const name = field(node, "name")?.text ?? "";
    const modifiers = childOf(node, "modifiers");
    const doc = docComment(node);
    const inInterface = parent?.kind === "interface";
    const decl = x.declare(
      {
        kind: KIND[node.type] ?? "class",
        name,
        node,
        exported: inInterface || hasModifier(modifiers, "public", "protected"),
        annotations: annotationsOf(modifiers),
        ...(doc ? { doc } : {}),
        signature: oneLine(
          node.text.slice(0, (field(node, "body")?.startIndex ?? node.endIndex) - node.startIndex),
        ),
      },
      parent,
    );
    const superclass = field(node, "superclass");
    if (superclass) {
      const type = typeOf(named(superclass)[0]);
      if (type) decl.bases.push({ type, relation: "extends" });
    }
    for (const list of [field(node, "interfaces"), childOf(node, "extends_interfaces")]) {
      if (!list) continue;
      const relation = node.type === "interface_declaration" ? "extends" : "implements";
      for (const t of named(childOf(list, "type_list") ?? list)) {
        const type = typeOf(t);
        if (type) decl.bases.push({ type, relation });
      }
    }
    // Record components are properties.
    for (const component of node.type === "record_declaration"
      ? childrenOf(field(node, "parameters") ?? node, "formal_parameter")
      : []) {
      const n = field(component, "name")?.text;
      const type = typeOf(field(component, "type"));
      if (n)
        x.declare(
          { kind: "property", name: n, node: component, exported: true, ...(type ? { type } : {}) },
          decl,
        );
    }
    const body = field(node, "body");
    for (const member of body ? named(body) : []) visitMember(member, decl);
  };

  const visitMember = (node: SyntaxNode, type: Decl): void => {
    const modifiers = childOf(node, "modifiers");
    const exported = type.kind === "interface" || hasModifier(modifiers, "public", "protected");
    const doc = docComment(node);
    switch (node.type) {
      case "class_declaration":
      case "record_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "annotation_type_declaration":
        visitType(node, type);
        return;
      case "enum_body_declarations":
        for (const child of named(node)) visitMember(child, type);
        return;
      case "enum_constant": {
        const name = field(node, "name")?.text ?? "";
        x.declare(
          { kind: "property", name, node, exported: type.exported, type: [type.name] },
          type,
        );
        return;
      }
      case "field_declaration":
      case "constant_declaration": {
        const fieldType = typeOf(field(node, "type"));
        for (const declarator of childrenOf(node, "variable_declarator")) {
          const name = field(declarator, "name")?.text ?? "";
          const decl = x.declare(
            {
              kind: "property",
              name,
              node,
              exported,
              static: hasModifier(modifiers, "static"),
              ...(fieldType ? { type: fieldType } : {}),
              ...(doc ? { doc } : {}),
            },
            type,
          );
          const value = field(declarator, "value");
          if (value) scan(value, decl);
        }
        return;
      }
      case "method_declaration":
      case "constructor_declaration":
      case "compact_constructor_declaration": {
        const isConstructor = node.type !== "method_declaration";
        const name = isConstructor ? type.name : (field(node, "name")?.text ?? "");
        const annotations = annotationsOf(modifiers);
        const isStatic = hasModifier(modifiers, "static");
        const main = name === "main" && isStatic;
        const test = annotations.some((a) => TEST_ANNOTATIONS.has(a.name));
        const returns = typeOf(field(node, "type"));
        const decl = x.declare(
          {
            kind: test ? "test" : "method",
            name,
            node,
            exported: exported || main,
            static: isStatic,
            annotations,
            signature: oneLine(
              `${field(node, "type")?.text ?? ""} ${name}${field(node, "parameters")?.text ?? "()"}`,
            ),
            ...(returns && returns[0] !== "void" ? { type: returns } : {}),
            ...(doc ? { doc } : {}),
            ...(isConstructor ? { meta: { ctor: true } } : main ? { meta: { entry: "main" } } : {}),
          },
          type,
        );
        params(decl, field(node, "parameters"));
        const body = field(node, "body");
        if (body) scan(body, decl);
        for (const route of annotatedRoutes(type.annotations, annotations, type.name, name)) {
          x.route({ ...route, node, handler: decl });
        }
        return;
      }
    }
  };

  for (const node of named(root)) {
    if (node.type === "import_declaration") {
      const target = named(node).find((n) => /identifier/.test(n.type));
      x.import({
        path: target?.text ?? "",
        node,
        ...(childOf(node, "asterisk") ? { wildcard: true } : {}),
        ...(/^import\s+static\b/.test(node.text) ? { form: "static" } : {}),
      });
    } else if (KIND[node.type]) visitType(node, undefined);
  }
  return x.model;
}

// ---- Kotlin -------------------------------------------------------------------------------

/** The identifier at the end of a navigation (`a.b`, `a?.b`). */
const lastIdentifier = (node: SyntaxNode): string =>
  [...named(node)]
    .reverse()
    .find((n) => n.type === "identifier" || n.type === "navigation_suffix")
    ?.text.replace(/^\??\./, "") ?? "";

function kotlinExpr(node: SyntaxNode | null | undefined): Expr {
  if (!node) return { kind: "unknown" };
  switch (node.type) {
    case "identifier":
    case "simple_identifier":
      return { kind: "name", name: node.text };
    case "this_expression":
      return { kind: "this" };
    case "super_expression":
      return { kind: "super" };
    case "navigation_expression":
      return { kind: "member", object: kotlinExpr(named(node)[0]), name: lastIdentifier(node) };
    case "call_expression":
      return { kind: "call", callee: kotlinExpr(named(node)[0]) };
    case "parenthesized_expression":
      return kotlinExpr(named(node)[0]);
    case "as_expression": {
      const type = typeOf(named(node).at(-1));
      return type ? { kind: "new", type } : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

const KOTLIN_TYPE = /^(user_type|nullable_type|function_type|parenthesized_type)$/;

function extractKotlin(tree: Tree, file: SourceFile): FileModel {
  const x = new Extraction(file, tree, TEST_FILE.test(file.path));
  const root = tree.rootNode;
  const header = childOf(root, "package_header");
  x.model.namespace = header
    ? (childOf(header, "qualified_identifier", "identifier")?.text ?? "")
    : "";

  const scan = (body: SyntaxNode, from: Decl | undefined): void => {
    for (const n of descendants(
      body,
      (d) => d.type === "class_body" || d.type === "object_literal",
    )) {
      if (n.type === "call_expression") {
        x.call(from, kotlinExpr(named(n)[0]), n);
      } else if (from && n.type === "property_declaration") {
        const variable = childOf(n, "variable_declaration");
        const name = variable && childOf(variable, "identifier", "simple_identifier")?.text;
        if (!name) continue;
        const type = typeOf(variable && named(variable).find((c) => KOTLIN_TYPE.test(c.type)));
        const init = named(n).find((c) => !same(c, variable) && c.type !== "modifiers");
        from.locals.set(name, type ? { type } : init ? { init: kotlinExpr(init) } : {});
      }
    }
  };

  const functionDecl = (node: SyntaxNode, parent: Decl | undefined): void => {
    const name =
      field(node, "name")?.text ?? childOf(node, "identifier", "simple_identifier")?.text ?? "";
    const modifiers = childOf(node, "modifiers");
    const annotations = annotationsOf(modifiers);
    const test = annotations.some((a) => TEST_ANNOTATIONS.has(a.name));
    const parameters = childOf(node, "function_value_parameters");
    const returns = named(node).find(
      (c) => KOTLIN_TYPE.test(c.type) && !!parameters && c.startIndex > parameters.startIndex,
    );
    const doc = docComment(node);
    const inType = parent && parent.kind !== "function";
    const decl = x.declare(
      {
        kind: test ? "test" : inType ? "method" : "function",
        name,
        node,
        exported: !hasModifier(modifiers, "private"),
        annotations,
        signature: oneLine(`${parameters?.text ?? "()"}${returns ? `: ${returns.text}` : ""}`),
        ...(typeOf(returns) ? { type: typeOf(returns) as TypeName } : {}),
        ...(doc ? { doc } : {}),
        ...(!parent && name === "main" ? { meta: { entry: "main" } } : {}),
      },
      parent,
    );
    const names: string[] = [];
    for (const p of parameters ? childrenOf(parameters, "parameter") : []) {
      const n = childOf(p, "identifier", "simple_identifier")?.text;
      const type = typeOf(named(p).find((c) => KOTLIN_TYPE.test(c.type)));
      if (!n) continue;
      decl.locals.set(n, type ? { type } : {});
      names.push(n);
    }
    decl.meta = { ...decl.meta, params: names };
    const body = childOf(node, "function_body");
    if (body) scan(body, decl);
    if (parent && CLASS_KINDS.has(parent.kind)) {
      for (const route of annotatedRoutes(parent.annotations, annotations, parent.name, name)) {
        x.route({ ...route, node, handler: decl });
      }
    }
  };

  const propertyDecl = (node: SyntaxNode, parent: Decl | undefined): void => {
    const variable = childOf(node, "variable_declaration");
    const name = variable && childOf(variable, "identifier", "simple_identifier")?.text;
    if (!name) return;
    const modifiers = childOf(node, "modifiers");
    const type = typeOf(variable && named(variable).find((c) => KOTLIN_TYPE.test(c.type)));
    const init = named(node).find(
      (c) => !same(c, variable) && c.type !== "modifiers" && !/getter|setter/.test(c.type),
    );
    const doc = docComment(node);
    const decl = x.declare(
      {
        kind: parent ? "property" : "variable",
        name,
        node,
        exported: !hasModifier(modifiers, "private"),
        ...(type ? { type } : {}),
        ...(doc ? { doc } : {}),
        ...(init ? { meta: { init: kotlinExpr(init) } } : {}),
      },
      parent,
    );
    if (init) scan(init, decl);
  };

  const classDecl = (node: SyntaxNode, parent: Decl | undefined): void => {
    const keywords = node.children.filter((c) => c && !c.isNamed).map((c) => c?.type);
    const modifiers = childOf(node, "modifiers");
    const isCompanion = node.type === "companion_object";
    const name =
      field(node, "name")?.text ??
      childOf(node, "identifier", "type_identifier")?.text ??
      (isCompanion ? "Companion" : "");
    const kind = keywords.includes("interface")
      ? "interface"
      : /\benum\b/.test(modifiers?.text ?? "")
        ? "enum"
        : "class";
    const doc = docComment(node);
    const decl = x.declare(
      {
        kind,
        name,
        node,
        exported: !hasModifier(modifiers, "private"),
        annotations: annotationsOf(modifiers),
        ...(doc ? { doc } : {}),
        signature: oneLine(
          node.text.slice(
            0,
            (childOf(node, "class_body", "enum_class_body")?.startIndex ?? node.endIndex) -
              node.startIndex,
          ),
        ),
        ...(node.type !== "class_declaration"
          ? { meta: { object: true, ...(isCompanion ? { companion: true } : {}) } }
          : {}),
      },
      parent,
    );
    // Primary constructor: val/var parameters are properties.
    const ctor = childOf(node, "primary_constructor");
    for (const p of ctor
      ? childrenOf(childOf(ctor, "class_parameters") ?? ctor, "class_parameter")
      : []) {
      const n = childOf(p, "identifier", "simple_identifier")?.text;
      const type = typeOf(named(p).find((c) => KOTLIN_TYPE.test(c.type)));
      if (!n || !/\b(val|var)\b/.test(p.text)) continue;
      x.declare(
        {
          kind: "property",
          name: n,
          node: p,
          exported: !/\bprivate\b/.test(p.text),
          ...(type ? { type } : {}),
        },
        decl,
      );
    }
    const delegation = childOf(node, "delegation_specifiers");
    for (const spec of delegation ? childrenOf(delegation, "delegation_specifier") : []) {
      const invocation = childOf(spec, "constructor_invocation");
      const type = typeOf(childOf(invocation ?? spec, "user_type"));
      if (type) decl.bases.push({ type, relation: invocation ? "extends" : "unknown" });
    }
    const body = childOf(node, "class_body", "enum_class_body");
    for (const member of body ? named(body) : []) {
      if (member.type === "function_declaration") functionDecl(member, decl);
      else if (member.type === "property_declaration") propertyDecl(member, decl);
      else if (/^(class_declaration|object_declaration|companion_object)$/.test(member.type))
        classDecl(member, decl);
      else if (member.type === "enum_entry") {
        const n = childOf(member, "identifier", "simple_identifier")?.text ?? "";
        x.declare(
          { kind: "property", name: n, node: member, exported: true, type: [decl.name] },
          decl,
        );
      } else if (
        member.type === "anonymous_initializer" ||
        member.type === "secondary_constructor"
      ) {
        const init = x.declare(
          { kind: "method", name: decl.name, node: member, exported: true, meta: { ctor: true } },
          decl,
        );
        scan(member, init);
      }
    }
  };

  for (const node of named(root)) {
    if (node.type === "import") {
      const target = childOf(node, "qualified_identifier", "identifier");
      const alias = named(node).find((c) => !same(c, target) && /identifier/.test(c.type))?.text;
      x.import({
        path: target?.text ?? "",
        node,
        ...(/\.\*\s*$/.test(node.text) ? { wildcard: true } : alias ? { alias } : {}),
      });
    } else if (/^(class_declaration|object_declaration)$/.test(node.type))
      classDecl(node, undefined);
    else if (node.type === "function_declaration") functionDecl(node, undefined);
    else if (node.type === "property_declaration") propertyDecl(node, undefined);
  }
  return x.model;
}

const CLASS_KINDS = new Set<Decl["kind"]>(["class", "interface", "enum"]);

/**
 * The Kotlin grammar fails on a nested class whose primary constructor starts on the next line
 * (`class Builder⏎  internal constructor(`), losing the whole enclosing class. Moving that line
 * break to just after `constructor(` reads the same and keeps every line number.
 */
export function prepareKotlin(text: string): string {
  return text.replace(
    /(\bclass\s+\w+(?:<[^>\n]*>)?)[ \t]*\n([ \t]*)((?:(?:public|private|internal|protected)\s+)?(?:@\w+(?:\([^)\n]*\))?\s+)*constructor\s*\()/g,
    "$1 $3\n$2",
  );
}

// ---- rules --------------------------------------------------------------------------------

const STANDARD = /^(java|javax|jdk|sun|kotlin)\./;

/** A Maven-ish group for an external import: `org.springframework`, `com.fasterxml.jackson`. */
function groupOf(path: string): string {
  const parts = path.split(".");
  const size =
    /^(io|com)$/.test(parts[0] ?? "") && /^(github|gitlab)$/.test(parts[1] ?? "")
      ? 3
      : parts.length > 3
        ? 3
        : 2;
  return parts.slice(0, Math.min(size, parts.length - 1)).join(".");
}

/** Java and Kotlin: packages, imports of classes, members and functions, wildcards. */
function jvmRules(): LanguageRules {
  const rules: LanguageRules = {
    language: "java",
    registry: "maven",
    separator: ".",
    namespaceOf: (file) => file.namespace,
    childNamespace: (key, name, project) => {
      const child = key ? `${key}.${name}` : name;
      return project.namespaces.has(child) ? child : undefined;
    },
    resolveImport(_file, imp, project): ImportResult {
      const path = imp.path;
      if (imp.wildcard) {
        if (project.namespaces.has(path)) {
          return { files: project.filesByNamespace.get(path) ?? [], open: [path] };
        }
        // `import static a.B.*` / `import a.B.*`: every member of a class.
        const type = resolvePath(project, path.split("."));
        if (type) {
          const bindings = project
            .membersOf(type)
            .map((m): [string, Binding] => [m.name, { kind: "decls", decls: [m] }]);
          return { files: [project.fileOf.get(type) as FileModel], bindings };
        }
      } else {
        const decl = resolvePath(project, path.split("."));
        if (decl) {
          return {
            files: [project.fileOf.get(decl) as FileModel],
            bindings: [[imp.alias ?? decl.name, { kind: "decls", decls: [decl] }]],
          };
        }
      }
      const name = imp.alias ?? path.split(".").pop() ?? path;
      const bindings: [string, Binding][] = imp.wildcard
        ? []
        : [[name, { kind: "external", name: path }]];
      if (STANDARD.test(path)) return { files: [], bindings };
      return { files: [], external: groupOf(path), bindings };
    },
  };
  return rules;
}

/** A declaration by its fully qualified name: the longest package prefix, then members. */
function resolvePath(project: Project, segments: string[]): Decl | undefined {
  for (let n = segments.length - 1; n >= 0; n--) {
    const key = segments.slice(0, n).join(".");
    if (!project.namespaces.has(key)) continue;
    let decl = project.inNamespace(key, segments[n] as string)[0];
    for (const segment of segments.slice(n + 1)) {
      decl = decl && project.membersOf(decl).find((m) => m.name === segment);
    }
    if (decl) return decl;
  }
  return undefined;
}

export const jvm: LanguageDefinition = {
  name: "jvm",
  dialects: [
    {
      language: "java",
      extensions: /\.java$/,
      grammar: { package: "tree-sitter-java", file: "tree-sitter-java.wasm" },
      extract: extractJava,
    },
    {
      language: "kt",
      extensions: /\.kts?$/,
      grammar: {
        package: "@tree-sitter-grammars/tree-sitter-kotlin",
        file: "tree-sitter-kotlin.wasm",
      },
      extract: extractKotlin,
      prepare: prepareKotlin,
    },
  ],
  rules: jvmRules,
};
