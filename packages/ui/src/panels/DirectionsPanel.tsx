import type { Summary } from "@xray/service";
import { useEffect } from "react";
import {
  ConfidenceMark,
  Empty,
  ErrorNote,
  Loading,
  NodeLink,
  useAsync,
} from "../components/common";
import { NodePicker } from "../components/NodePicker";
import { useApp } from "../context";
import { edgeVerb, plural } from "../format";
import { useStore } from "../state";

/** "Directions": how one piece of code reaches another, through calls. */
export function DirectionsPanel() {
  const { backend, store, theme, open, frame, setOverlay } = useApp();
  const from = useStore(store, (s) => s.from);
  const to = useStore(store, (s) => s.to);
  const route = useStore(store, (s) => s.route);
  const fromNode = useAsync(
    () => (from ? backend.resolve(from).then((r) => r[0]) : undefined),
    [backend, from],
  );
  const toNode = useAsync(
    () => (to ? backend.resolve(to).then((r) => r[0]) : undefined),
    [backend, to],
  );
  const trace = useAsync(
    () => (from && to ? backend.trace(from, to, 5) : undefined),
    [backend, from, to],
  );
  const paths = trace.data?.paths ?? [];
  const chosen = paths[Math.min(route, paths.length - 1)];

  useEffect(() => {
    if (!chosen) return;
    const colors = new Map<string, string>(
      chosen.nodes.map((n, i) => [
        n.id,
        i === 0 ? "#2f9e44" : i === chosen.nodes.length - 1 ? "#e03131" : "#1971c2",
      ]),
    );
    setOverlay({
      highlight: { colors, dim: true },
      edges: chosen.edges.map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
        confidence: e.confidence,
        emphasis: "route" as const,
      })),
    });
    frame(chosen.nodes.map((n) => n.id));
    return () => setOverlay(undefined);
  }, [chosen, setOverlay, frame]);

  const swap = () => store.set({ from: to, to: from, route: 0 });
  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">Directions</div>
        <h2 className="node-title">How does it get there?</h2>
        <p className="muted">
          The shortest call routes between two pieces of code. Sure links are preferred over
          guesses.
        </p>
      </header>
      <NodePicker
        label="From"
        value={fromNode.data as Summary | undefined}
        placeholder="Search a start, e.g. a route"
        onPick={(id) => store.set({ from: id, route: 0 })}
      />
      <button type="button" className="link-button swap" onClick={swap} disabled={!from && !to}>
        ⇅ swap
      </button>
      <NodePicker
        label="To"
        value={toNode.data as Summary | undefined}
        placeholder="Search a destination"
        onPick={(id) => store.set({ to: id, route: 0 })}
      />

      {from && to && trace.loading && <Loading label="Finding routes" />}
      {trace.error && <ErrorNote error={trace.error} />}
      {from && to && !trace.loading && paths.length === 0 && (
        <Empty>
          No call route from the start to the destination. Try swapping them: calls only run one
          way.
        </Empty>
      )}
      {paths.length > 0 && (
        <>
          <div className="route-tabs" role="tablist">
            {paths.map((p, i) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: routes are ranked by position
                key={i}
                type="button"
                role="tab"
                aria-selected={i === route}
                className={i === route ? "route-tab active" : "route-tab"}
                onClick={() => store.set({ route: i })}
              >
                {plural(p.nodes.length - 1, "step")}
                {p.confidence !== "exact" && <ConfidenceMark confidence={p.confidence} />}
              </button>
            ))}
          </div>
          {chosen && (
            <ol className="route">
              {chosen.nodes.map((n, i) => {
                const edge = i > 0 ? chosen.edges[i - 1] : undefined;
                return (
                  <li key={n.id}>
                    {edge && (
                      <div className="route-edge">
                        {edgeVerb(edge.kind, true)}
                        <ConfidenceMark confidence={edge.confidence} />
                        {edge.location && (
                          <span className="mono muted">
                            {" "}
                            at {edge.location.file}:{edge.location.line}
                          </span>
                        )}
                      </div>
                    )}
                    <NodeLink node={n} theme={theme} onOpen={open} />
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
