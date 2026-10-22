import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type Graph, type Language, moduleId, parseId } from "@xray/schema";
import { describe, expect, it } from "vitest";
import { listFixtures, loadFixture, scoreGraph } from "../src/index.js";

const SOURCE_EXTENSIONS: Record<string, Language> = {
  ".ts": "ts",
  ".js": "js",
  ".py": "py",
  ".go": "go",
  ".java": "java",
  ".kt": "kt",
  ".rs": "rs",
  ".cs": "cs",
  ".php": "php",
  ".rb": "rb",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return Object.keys(SOURCE_EXTENSIONS).some((ext) => entry.endsWith(ext)) ? [path] : [];
  });
}

describe("fixtures", () => {
  const names = listFixtures();

  it("are all discovered", () => {
    expect(names).toEqual([
      "cs-aspnet",
      "go-modules",
      "js-commonjs",
      "jvm-mixed",
      "php-laravel",
      "py-classes",
      "py-cycles",
      "py-packages",
      "rb-rails",
      "rs-workspace",
      "ts-classes",
      "ts-cycles",
      "ts-reexports",
    ]);
  });

  describe.each(names)("%s", (name) => {
    const { dir, expected } = loadFixture(name);
    const nodeIds = new Set(expected.nodes.map((node) => node.id));

    it("has a module node for every source file, and nothing else", () => {
      const modules = expected.nodes
        .filter((node) => node.kind === "module")
        .map((node) => node.id);
      const files = sourceFiles(dir).map((file) => {
        const path = relative(dir, file).replaceAll("\\", "/");
        const ext = path.slice(path.lastIndexOf("."));
        return moduleId(SOURCE_EXTENSIONS[ext] as Language, path);
      });
      expect(modules.sort()).toEqual(files.sort());
    });

    it("has unique, well-formed node ids whose symbols appear in their files", () => {
      expect(nodeIds.size).toBe(expected.nodes.length);
      for (const node of expected.nodes) {
        const parsed = parseId(node.id);
        expect(parsed?.type, node.id).toBe(
          node.kind === "module" ? "module" : node.kind === "external" ? "external" : "symbol",
        );
        if (parsed?.type === "symbol") {
          expect(nodeIds.has(moduleId(parsed.language, parsed.path)), node.id).toBe(true);
          // Routes, test titles and Kotlin's implicit Companion are named by xray, not the code.
          if (
            node.kind === "route" ||
            node.kind === "test" ||
            /\bCompanion\b/.test(parsed.qualifiedName)
          )
            continue;
          const source = readFileSync(join(dir, parsed.path), "utf8");
          const name = parsed.qualifiedName.split(".").at(-1) ?? "";
          const escaped = name.replace(/[.*+?^${}()|[\]\\!]/g, "\\$&");
          const end = /\w$/.test(name) ? "\\b" : "";
          expect(source, node.id).toMatch(new RegExp(`\\b${escaped}${end}`));
        }
      }
    });

    it("has edges between known nodes, of scored kinds, without duplicates", () => {
      const keys = new Set<string>();
      for (const edge of expected.edges) {
        const key = `${edge.source} -${edge.kind}-> ${edge.target}`;
        expect(nodeIds.has(edge.source), key).toBe(true);
        expect(nodeIds.has(edge.target), key).toBe(true);
        expect(expected.edgeKinds, key).toContain(edge.kind);
        expect(keys.has(key), `duplicate ${key}`).toBe(false);
        keys.add(key);
      }
    });

    it("lists cycles as sorted module ids that import each other", () => {
      for (const cycle of expected.cycles ?? []) {
        expect(cycle).toEqual([...cycle].sort());
        for (const id of cycle) {
          expect(expected.nodes.find((node) => node.id === id)?.kind, id).toBe("module");
          const importsIntoCycle = expected.edges.some(
            (edge) => edge.kind === "imports" && edge.source === id && cycle.includes(edge.target),
          );
          expect(importsIntoCycle, id).toBe(true);
        }
      }
    });

    it("scores a perfect extraction as 1/1", () => {
      const graph: Graph = {
        version: 1,
        nodes: expected.nodes.map((node) => ({ ...node, name: node.id, qualifiedName: node.id })),
        edges: expected.edges.map((edge) => ({ ...edge, confidence: edge.confidence ?? "exact" })),
      };
      const score = scoreGraph(expected, graph);
      expect(score.missingNodes).toEqual([]);
      expect(score.precision).toBe(1);
      expect(score.recall).toBe(1);
    });
  });
});

describe("scoreGraph", () => {
  it("reports missing and unexpected edges per kind", () => {
    const { expected } = loadFixture("ts-cycles");
    const graph: Graph = {
      version: 1,
      nodes: [],
      edges: [
        { source: "ts:src/a.ts", kind: "imports", target: "ts:src/b.ts", confidence: "exact" },
        { source: "ts:src/a.ts", kind: "imports", target: "ts:src/f.ts", confidence: "exact" },
        // Not a scored kind for this fixture, so it is ignored.
        { source: "ts:src/a.ts", kind: "references", target: "ts:src/f.ts", confidence: "exact" },
      ],
    };
    const score = scoreGraph(expected, graph);
    const imports = score.kinds.find((kind) => kind.kind === "imports");
    expect(imports).toMatchObject({ expected: 6, found: 2, precision: 0.5 });
    expect(imports?.recall).toBeCloseTo(1 / 6);
    expect(imports?.unexpected).toEqual(["ts:src/a.ts -imports-> ts:src/f.ts"]);
    expect(score.missingNodes).toHaveLength(expected.nodes.length);
    expect(score.kinds.find((kind) => kind.kind === "calls")).toMatchObject({
      found: 0,
      precision: 1,
      recall: 0,
    });
  });
});
