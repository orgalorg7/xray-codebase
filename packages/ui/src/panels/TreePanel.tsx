import type { CallTree } from "@xray/analysis";
import type { Summary } from "@xray/service";
import { useEffect, useMemo, useState } from "react";
import { ConfidenceMark, ErrorNote, Loading, NodeLink, useAsync } from "../components/common";
import { useApp } from "../context";

/** A call tree (what it calls) or caller tree (what calls it), expandable level by level. */
export function TreePanel({ id, direction }: { id: string; direction: "in" | "out" }) {
  const { backend, store, setOverlay, frame } = useApp();
  const [depth, setDepth] = useState(3);
  const tree = useAsync(() => backend.tree(id, direction, depth), [backend, id, direction, depth]);
  const nodes = tree.data?.nodes ?? {};
  const root = tree.data?.tree;

  const edges = useMemo(() => {
    const out: { source: string; target: string; kind: string; confidence: string }[] = [];
    const visit = (t: CallTree) => {
      for (const c of t.children) {
        if (c.edge)
          out.push({
            source: c.edge.source,
            target: c.edge.target,
            kind: c.edge.kind,
            confidence: c.edge.confidence,
          });
        visit(c);
      }
    };
    if (root) visit(root);
    return out;
  }, [root]);

  useEffect(() => {
    if (!root) return;
    const ids = Object.keys(nodes);
    setOverlay({
      highlight: {
        colors: new Map(ids.map((n) => [n, n === id ? "#1971c2" : "#4dabf7"])),
        dim: true,
      },
      edges: edges.map((e) => ({ ...e, kind: e.kind as never, confidence: e.confidence as never })),
    });
    frame(ids);
    return () => setOverlay(undefined);
  }, [root, nodes, edges, id, setOverlay, frame]);

  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">{direction === "out" ? "Call tree" : "Callers"}</div>
        <h2 className="node-title">{nodes[id]?.label ?? id}</h2>
        <div className="controls-row">
          <button
            type="button"
            onClick={() =>
              store.set({ tree: { id, direction: direction === "out" ? "in" : "out" } })
            }
          >
            Show {direction === "out" ? "callers" : "what it calls"}
          </button>
          <button type="button" onClick={() => store.set({ tree: undefined })}>
            Close
          </button>
        </div>
      </header>
      {tree.loading && <Loading />}
      {tree.error && <ErrorNote error={tree.error} />}
      {root && root.children.length === 0 && (
        <p className="muted">
          {direction === "out"
            ? "It calls nothing in the repository."
            : "Nothing in the repository calls it."}
        </p>
      )}
      {root && (
        <ul className="tree">
          {root.children.map((c) => (
            <TreeNode key={c.id} tree={c} nodes={nodes} onMore={() => setDepth((d) => d + 2)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TreeNode({
  tree,
  nodes,
  onMore,
}: {
  tree: CallTree;
  nodes: Record<string, Summary>;
  onMore: () => void;
}) {
  const { theme, open } = useApp();
  const [expanded, setExpanded] = useState(true);
  const summary = nodes[tree.id];
  if (!summary) return null;
  return (
    <li>
      <div className="tree-row">
        {tree.children.length > 0 ? (
          <button
            type="button"
            className="tree-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle" />
        )}
        <NodeLink
          node={summary}
          theme={theme}
          onOpen={open}
          detail={
            <>
              {tree.edge && <ConfidenceMark confidence={tree.edge.confidence} />}
              {tree.recursive && <span className="tag">recursive</span>}
            </>
          }
        />
        {tree.truncated && tree.children.length === 0 && (
          <button type="button" className="link-button" onClick={onMore}>
            more…
          </button>
        )}
      </div>
      {expanded && tree.children.length > 0 && (
        <ul>
          {tree.children.map((c) => (
            <TreeNode key={c.id} tree={c} nodes={nodes} onMore={onMore} />
          ))}
        </ul>
      )}
    </li>
  );
}
