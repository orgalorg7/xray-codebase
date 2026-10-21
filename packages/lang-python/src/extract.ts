import type { SyntaxNode, Tree } from "@xray/parser";

export type DefKind = "function" | "class" | "variable" | "method" | "property" | "test";

export type Def = {
  kind: DefKind;
  name: string;
  qualifiedName: string;
  /** The outermost node, including decorators. Used for locations. */
  node: SyntaxNode;
  /** function_definition, class_definition or assignment. */
  definition: SyntaxNode;
  decorators: SyntaxNode[];
  doc?: string;
  signature?: string;
  /** Class members by name (classes only). */
  members: Map<string, Def>;
  parent?: Def;
  methodKind?: "instance" | "class" | "static";
};

export type ImportRecord = {
  node: SyntaxNode;
  /** Number of leading dots in a relative import. */
  level: number;
  /** Dotted module path, "" for `from . import x`. */
  module: string;
  /** Imported names for `from` imports, "*" for star imports, undefined for `import x`. */
  names: { name: string; alias?: string }[] | "*" | undefined;
  /** `import a.b as c` binds c. */
  alias?: string;
  /** Inside a function body: executed lazily, bound locally. */
  scope?: Def;
  typeOnly: boolean;
};

export type ModuleInfo = {
  path: string;
  isPackage: boolean;
  tree: Tree;
  /** Top-level definitions by name. */
  defs: Map<string, Def>;
  /** Every definition, members included, in source order. */
  allDefs: Def[];
  imports: ImportRecord[];
  /** Literal `__all__`, when present. */
  all?: string[];
  isTestFile: boolean;
};

const TEST_FILE = /(^|\/)(tests?\/.*\.py|test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/;

export const field = (node: SyntaxNode, name: string): SyntaxNode | null =>
  node.childForFieldName(name);

const named = (node: SyntaxNode): SyntaxNode[] =>
  node.namedChildren.filter((n): n is SyntaxNode => n !== null);

/** The literal value of a plain (non-f) string node, or undefined. */
export function stringValue(node: SyntaxNode | null | undefined): string | undefined {
  if (node?.type !== "string") return undefined;
  const parts = named(node);
  if (parts.some((part) => part.type === "interpolation")) return undefined;
  return parts
    .filter((part) => part.type === "string_content")
    .map((part) => part.text)
    .join("");
}

function docstring(body: SyntaxNode | null): string | undefined {
  const first = body ? named(body)[0] : undefined;
  if (first?.type !== "expression_statement") return undefined;
  const text = stringValue(named(first)[0]);
  const paragraph = text
    ?.trim()
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  if (!paragraph) return undefined;
  return paragraph.length > 500 ? `${paragraph.slice(0, 497)}...` : paragraph;
}

function signature(definition: SyntaxNode): string | undefined {
  const parameters = field(definition, "parameters");
  if (!parameters) return undefined;
  const returns = field(definition, "return_type");
  const text = `${parameters.text.replace(/\s+/g, " ")}${returns ? ` -> ${returns.text}` : ""}`;
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

const isDunder = (name: string): boolean => name.startsWith("__") && name.endsWith("__");

function parseImport(
  statement: SyntaxNode,
  scope: Def | undefined,
  typeOnly: boolean,
): ImportRecord[] {
  const base = { node: statement, typeOnly, ...(scope ? { scope } : {}) };
  if (statement.type === "import_statement") {
    return named(statement).map((item) => {
      if (item.type === "aliased_import") {
        const alias = field(item, "alias")?.text;
        return {
          ...base,
          level: 0,
          module: field(item, "name")?.text ?? "",
          names: undefined,
          ...(alias ? { alias } : {}),
        };
      }
      return { ...base, level: 0, module: item.text, names: undefined };
    });
  }
  // import_from_statement
  const moduleNode = field(statement, "module_name");
  let level = 0;
  let module = moduleNode?.text ?? "";
  if (moduleNode?.type === "relative_import") {
    const prefix = named(moduleNode).find((n) => n.type === "import_prefix");
    level = prefix?.text.length ?? 0;
    module = named(moduleNode).find((n) => n.type === "dotted_name")?.text ?? "";
  }
  if (named(statement).some((n) => n.type === "wildcard_import")) {
    return [{ ...base, level, module, names: "*" }];
  }
  const names = statement.childrenForFieldName("name").flatMap((item) => {
    if (!item) return [];
    if (item.type === "aliased_import") {
      const alias = field(item, "alias")?.text;
      return [{ name: field(item, "name")?.text ?? "", ...(alias ? { alias } : {}) }];
    }
    return [{ name: item.text }];
  });
  return [{ ...base, level, module, names }];
}

const isTypeCheckingGuard = (statement: SyntaxNode): boolean =>
  statement.type === "if_statement" &&
  /^(typing\.)?TYPE_CHECKING$/.test(field(statement, "condition")?.text ?? "");

/** Parses one file's definitions and imports. Pure: depends on nothing but the file. */
export function extractModule(path: string, tree: Tree): ModuleInfo {
  const info: ModuleInfo = {
    path,
    isPackage: /(^|\/)__init__\.py$/.test(path),
    tree,
    defs: new Map(),
    allDefs: [],
    imports: [],
    isTestFile: TEST_FILE.test(path),
  };

  const addDef = (def: Def, container: Map<string, Def>): void => {
    if (!container.has(def.name)) container.set(def.name, def);
    info.allDefs.push(def);
  };

  const visitBlock = (block: SyntaxNode, parent: Def | undefined, typeOnly: boolean): void => {
    for (const statement of named(block)) visitStatement(statement, parent, typeOnly);
  };

  const visitStatement = (
    statement: SyntaxNode,
    parent: Def | undefined,
    typeOnly: boolean,
  ): void => {
    const container = parent ? parent.members : info.defs;
    const prefix = parent ? `${parent.qualifiedName}.` : "";
    switch (statement.type) {
      case "decorated_definition":
      case "function_definition":
      case "class_definition": {
        const definition =
          statement.type === "decorated_definition" ? field(statement, "definition") : statement;
        if (!definition) return;
        const decorators = named(statement)
          .filter((n) => n.type === "decorator")
          .flatMap((n) => named(n).slice(0, 1));
        const name = field(definition, "name")?.text;
        if (!name) return;
        const body = field(definition, "body");
        const isClass = definition.type === "class_definition";
        const decoratorNames = decorators.map((d) => d.text);
        const isTest =
          info.isTestFile &&
          !isClass &&
          name.startsWith("test") &&
          (parent === undefined || parent.name.startsWith("Test"));
        const def: Def = {
          kind: isClass ? "class" : isTest ? "test" : parent ? "method" : "function",
          name,
          qualifiedName: `${prefix}${name}`,
          node: statement,
          definition,
          decorators,
          members: new Map(),
          ...(parent ? { parent } : {}),
        };
        const doc = docstring(body);
        if (doc) def.doc = doc;
        if (!isClass) {
          const sig = signature(definition);
          if (sig) def.signature = sig;
        }
        if (parent && !isClass) {
          def.methodKind = decoratorNames.includes("classmethod")
            ? "class"
            : decoratorNames.includes("staticmethod")
              ? "static"
              : "instance";
        }
        addDef(def, container);
        if (isClass && body) visitBlock(body, def, typeOnly);
        else if (body) collectDeferredImports(body, def);
        return;
      }
      case "expression_statement": {
        const assignment = named(statement)[0];
        if (assignment?.type !== "assignment") return;
        const left = field(assignment, "left");
        if (left?.type !== "identifier") return;
        if (left.text === "__all__" && !parent) {
          const list = field(assignment, "right");
          if (list?.type === "list" || list?.type === "tuple") {
            info.all = named(list).flatMap((item) => stringValue(item) ?? []);
          }
          return;
        }
        if (isDunder(left.text) || container.has(left.text)) return;
        addDef(
          {
            kind: parent ? "property" : "variable",
            name: left.text,
            qualifiedName: `${prefix}${left.text}`,
            node: statement,
            definition: assignment,
            decorators: [],
            members: new Map(),
            ...(parent ? { parent } : {}),
          },
          container,
        );
        return;
      }
      case "import_statement":
      case "import_from_statement":
        if (!parent) info.imports.push(...parseImport(statement, undefined, typeOnly));
        return;
      default:
        // if / try / with / for / while at module or class level still declare in that scope.
        for (const child of named(statement)) {
          if (child.type === "block")
            visitBlock(child, parent, typeOnly || isTypeCheckingGuard(statement));
          else if (/_clause$/.test(child.type)) {
            for (const inner of named(child)) {
              if (inner.type === "block") visitBlock(inner, parent, typeOnly);
            }
          }
        }
    }
  };

  /** Imports anywhere inside a function body are deferred and bound in that function. */
  const collectDeferredImports = (body: SyntaxNode, scope: Def): void => {
    for (const statement of body.descendantsOfType(["import_statement", "import_from_statement"])) {
      if (statement) info.imports.push(...parseImport(statement, scope, false));
    }
  };

  visitBlock(tree.rootNode, undefined, false);
  return info;
}
