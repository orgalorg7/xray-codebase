import { describe, expect, it } from "vitest";
import {
  directoryId,
  externalId,
  type Graph,
  moduleId,
  normalizePath,
  packageId,
  parseId,
  REPO_ID,
  symbolId,
  validateGraph,
} from "../src/index.js";

describe("ids", () => {
  it("builds the documented formats", () => {
    expect(moduleId("ts", "src/auth/login.ts")).toBe("ts:src/auth/login.ts");
    expect(symbolId("ts", "src/auth/login.ts", "AuthService.login")).toBe(
      "ts:src/auth/login.ts#AuthService.login",
    );
    expect(symbolId("ts", "src/parse.ts", "parse", "string")).toBe("ts:src/parse.ts#parse(string)");
    expect(directoryId("src/auth/")).toBe("dir:src/auth");
    expect(packageId("@acme/web")).toBe("pkg:@acme/web");
    expect(externalId("npm", "@types/node")).toBe("ext:npm/@types/node");
  });

  it("normalizes paths", () => {
    expect(normalizePath("./src\\a.ts")).toBe("src/a.ts");
    expect(normalizePath("/src/lib/")).toBe("src/lib");
    expect(moduleId("py", "./app/main.py")).toBe("py:app/main.py");
  });

  it("round-trips through parseId", () => {
    const cases = [
      moduleId("py", "app/main.py"),
      symbolId("js", "lib/logger.js", "Logger.log"),
      symbolId("ts", "src/parse.ts", "parse", "string, number"),
      symbolId("ts", "src/parse.ts", "parse", ""),
      directoryId("src"),
      packageId("@acme/web"),
      externalId("pypi", "requests"),
      REPO_ID,
    ];
    for (const id of cases) {
      const parsed = parseId(id);
      expect(parsed, id).toBeDefined();
      if (parsed?.type === "symbol") {
        expect(symbolId(parsed.language, parsed.path, parsed.qualifiedName, parsed.signature)).toBe(
          id,
        );
      }
    }
    expect(parseId(symbolId("ts", "src/parse.ts", "parse", "a: (x) => y"))).toEqual({
      type: "symbol",
      language: "ts",
      path: "src/parse.ts",
      qualifiedName: "parse",
      signature: "a: (x) => y",
    });
  });

  it("escapes # and % in paths", () => {
    const id = symbolId("ts", "src/c#/100%.ts", "run");
    expect(id).toBe("ts:src/c%23/100%25.ts#run");
    expect(parseId(id)).toEqual({
      type: "symbol",
      language: "ts",
      path: "src/c#/100%.ts",
      qualifiedName: "run",
    });
  });

  it("rejects malformed ids", () => {
    for (const id of ["", "nope", "rb:x.rb", "ts:", "ts:a.ts#", "ext:npm", "ext:/x", ":x"]) {
      expect(parseId(id), id).toBeUndefined();
    }
  });
});

describe("validateGraph", () => {
  const graph: Graph = {
    version: 1,
    nodes: [
      { id: "ts:a.ts", kind: "module", name: "a.ts", qualifiedName: "a.ts", language: "ts" },
      {
        id: "ts:a.ts#run",
        kind: "function",
        name: "run",
        qualifiedName: "run",
        language: "ts",
        location: { file: "a.ts", line: 1, column: 1 },
      },
    ],
    edges: [{ source: "ts:a.ts", target: "ts:a.ts#run", kind: "contains", confidence: "exact" }],
  };

  it("accepts a well-formed graph", () => {
    expect(validateGraph(graph)).toEqual({ ok: true, graph });
  });

  it("reports schema errors", () => {
    const result = validateGraph({ ...graph, version: 2 });
    expect(result.ok).toBe(false);
  });

  it("reports duplicate ids and dangling edges", () => {
    const broken = {
      ...graph,
      nodes: [...graph.nodes, graph.nodes[0]],
      edges: [
        ...graph.edges,
        { source: "ts:a.ts#run", target: "ts:b.ts", kind: "calls", confidence: "heuristic" },
      ],
    };
    const result = validateGraph(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(["nodes.2.id", "edges.1.target"]);
    }
  });
});
