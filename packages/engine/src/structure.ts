import { existsSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { directoryId, type GraphEdge, type GraphNode, REPO_ID } from "@xray/schema";

/** A package manifest's declared name, if the directory has one. */
function packageName(dir: string): { name: string; manifest: string } | undefined {
  const packageJson = join(dir, "package.json");
  if (existsSync(packageJson)) {
    try {
      const { name } = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
      if (typeof name === "string" && name !== "") return { name, manifest: "package.json" };
    } catch {
      // Malformed manifests are treated as plain directories.
    }
  }
  const pyproject = join(dir, "pyproject.toml");
  if (existsSync(pyproject)) {
    const match = /^name\s*=\s*["']([^"']+)["']/m.exec(readFileSync(pyproject, "utf8"));
    if (match?.[1]) return { name: match[1], manifest: "pyproject.toml" };
  }
  return undefined;
}

/**
 * The containment skeleton above modules: the repo node, then one node per directory that holds
 * source files (kind `package` when it has a manifest), linked by `contains` down to modules.
 */
export function buildStructure(
  root: string,
  modules: readonly { id: string; path: string }[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const rootPackage = packageName(root);
  const repo: GraphNode = { id: REPO_ID, kind: "repo", name: basename(root), qualifiedName: "." };
  if (rootPackage) repo.meta = { packageName: rootPackage.name, manifest: rootPackage.manifest };
  const nodes = new Map<string, GraphNode>([[REPO_ID, repo]]);
  const edges: GraphEdge[] = [];
  const linked = new Set<string>();

  const ensureDirectory = (dir: string): string => {
    if (dir === "." || dir === "") return REPO_ID;
    const id = directoryId(dir);
    if (!nodes.has(id)) {
      const pkg = packageName(join(root, dir));
      const node: GraphNode = {
        id,
        kind: pkg ? "package" : "directory",
        name: posix.basename(dir),
        qualifiedName: dir,
      };
      if (pkg) node.meta = { packageName: pkg.name, manifest: pkg.manifest };
      nodes.set(id, node);
      const parent = ensureDirectory(posix.dirname(dir));
      edges.push({ source: parent, target: id, kind: "contains", confidence: "exact" });
    }
    return id;
  };

  for (const mod of modules) {
    if (linked.has(mod.id)) continue;
    linked.add(mod.id);
    const parent = ensureDirectory(posix.dirname(mod.path));
    edges.push({ source: parent, target: mod.id, kind: "contains", confidence: "exact" });
  }
  return { nodes: [...nodes.values()], edges };
}
