import { commitOf, revisionsOf, serviceAt } from "@xray/server/revisions";
import type { Workspace } from "@xray/server/workspace";
import { compareSnapshots, type FileSymbol, type Summary } from "@xray/service";

type ImpactRequest = { ids: string[]; depth?: number; heuristic?: boolean };

export type Handler = (...args: never[]) => unknown;

/**
 * The worker's methods. Map methods mirror the UI's Backend (same names and arguments), so the
 * extension relays webview requests as they are; editor methods serve CodeLens, hovers and
 * commands.
 */
export function createHandlers(workspace: Workspace): Record<string, Handler> {
  const service = () => workspace.service();
  return {
    // ---- map ------------------------------------------------------------------------------
    meta: async () => (await service()).meta(),
    map: async () => (await service()).map(),
    roads: async (depth: number) => (await service()).roads(depth),
    node: async (id: string) => (await service()).node(id),
    source: async (file: string, start?: number, end?: number) =>
      (await service()).source(file, start ?? 1, end ?? Number.POSITIVE_INFINITY),
    search: async (query: string, limit?: number) => (await service()).search(query, limit),
    resolve: async (reference: string) => (await service()).resolve(reference),
    impact: async (request: ImpactRequest) =>
      (await service()).impact(request.ids, {
        ...(request.depth === undefined || request.depth === null
          ? {}
          : { maxDepth: request.depth }),
        ...(request.heuristic === undefined || request.heuristic === null
          ? {}
          : { includeHeuristic: request.heuristic }),
      }),
    trace: async (from: string, to: string, k?: number) =>
      (await service()).trace(from, to, k ? { k } : {}),
    tree: async (id: string, direction: "in" | "out", depth?: number) =>
      (await service()).tree(id, direction, depth ?? 3),
    cycles: async (ignoreTypeOnly?: boolean) =>
      (await service()).cycles({ ignoreTypeOnly: ignoreTypeOnly ?? false }),
    insights: async () => (await service()).insights(),
    dsm: async (level: "module" | "directory") => (await service()).dsm(level),

    // ---- editor ---------------------------------------------------------------------------
    /** Declarations in a file with caller counts, for CodeLens. */
    fileSymbols: async (file: string): Promise<FileSymbol[]> => (await service()).fileSymbols(file),
    /** The innermost declaration containing a line (1-based), for hovers and commands. */
    symbolAt: async (file: string, line: number): Promise<Summary | undefined> => {
      const matches = (await service()).resolve(`${file}:${line}`);
      return matches.find((m) => m.kind !== "module") ?? matches[0];
    },
    // ---- changes ----------------------------------------------------------------------------
    revisions: async () => revisionsOf(workspace.root),
    diff: async (base: string) => {
      const commit = commitOf(workspace.root, base);
      const [{ service: before }, current] = await Promise.all([
        serviceAt(workspace.root, commit),
        service(),
      ]);
      return compareSnapshots(before, current, { before: base, after: "the working tree" });
    },
    scan: async (force?: boolean) => {
      const report = await workspace.scan({ force: force ?? false });
      return {
        files: report.files,
        nodes: report.nodes,
        edges: report.edges,
        ms: Math.round(report.timings.total),
      };
    },
  };
}
