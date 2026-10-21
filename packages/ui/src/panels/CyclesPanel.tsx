import type { CycleView } from "@xray/service";
import { useEffect } from "react";
import {
  Empty,
  ErrorNote,
  Limited,
  Loading,
  NodeLink,
  Section,
  useAsync,
} from "../components/common";
import { useApp } from "../context";
import { plural, shortPath } from "../format";
import { useStore } from "../state";
import { FocusGraph } from "./FocusGraph";

/** Circular imports and mutual recursion, with the smallest set of edges to cut. */
export function CyclesPanel() {
  const { backend, store, theme, open, frame, setOverlay } = useApp();
  const ignoreTypeOnly = useStore(store, (s) => s.ignoreTypeOnly);
  const selected = useStore(store, (s) => s.cycle);
  const cycles = useAsync(() => backend.cycles(ignoreTypeOnly), [backend, ignoreTypeOnly]);
  const all = cycles.data?.imports ?? [];
  const cycle = selected === undefined ? undefined : all[selected];

  useEffect(() => {
    if (!cycle) return;
    const colors = new Map(cycle.members.map((m) => [m.id, "#e03131"]));
    setOverlay({
      highlight: { colors, dim: true },
      edges: cycle.edges.map((e) => ({
        source: e.source,
        target: e.target,
        kind: e.kind,
        confidence: e.confidence,
        emphasis: cycle.cut.some((c) => c.source === e.source && c.target === e.target)
          ? ("cut" as const)
          : ("normal" as const),
      })),
    });
    frame(cycle.members.map((m) => m.id));
    return () => setOverlay(undefined);
  }, [cycle, setOverlay, frame]);

  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">Cycles</div>
        <h2 className="node-title">Circular dependencies</h2>
        <p className="muted">
          Files that import each other, directly or around a loop. Red dashed edges are the
          suggested cuts.
        </p>
      </header>
      <label className="controls-row">
        <input
          type="checkbox"
          checked={ignoreTypeOnly}
          onChange={(e) => store.set({ ignoreTypeOnly: e.target.checked, cycle: undefined })}
        />{" "}
        ignore type-only imports
      </label>
      {cycles.loading && <Loading label="Finding cycles" />}
      {cycles.error && <ErrorNote error={cycles.error} />}
      {cycles.data && all.length === 0 && <Empty>No circular imports. 🎉</Empty>}
      {cycle && <CycleDetails cycle={cycle} />}
      {all.length > 0 && (
        <Section title="Import cycles" count={all.length}>
          {all.map((c, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: cycles are listed by position
              key={i}
              type="button"
              className={i === selected ? "cycle-row active" : "cycle-row"}
              onClick={() => store.set({ cycle: i === selected ? undefined : i })}
            >
              <span className="cycle-size">{c.members.length}</span>
              <span className="cycle-members">
                {c.members.map((m) => shortPath(m.label, 30)).join(" → ")}
              </span>
            </button>
          ))}
        </Section>
      )}
      {cycles.data && cycles.data.calls.length > 0 && (
        <Section title="Mutual recursion" count={cycles.data.calls.length} defaultOpen={false}>
          {cycles.data.calls.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: listed by position
            <div key={i} className="cycle-calls">
              <Limited
                items={c.members}
                limit={6}
                render={(m) => <NodeLink key={m.id} node={m} theme={theme} onOpen={open} />}
              />
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function CycleDetails({ cycle }: { cycle: CycleView }) {
  return (
    <div className="cycle-details">
      <h3>{plural(cycle.members.length, "file")} in a loop</h3>
      {cycle.members.length <= 12 ? (
        <FocusGraph nodes={cycle.members} edges={cycle.edges} cut={cycle.cut} />
      ) : (
        <p className="muted">
          Too many files to draw as a diagram: the loop is highlighted on the map.
        </p>
      )}
      <h4>To break it, remove</h4>
      <ul className="cut-list">
        {cycle.cut.map((e) => (
          <li key={`${e.source}->${e.target}`}>
            <span className="mono">
              {e.location ? `${e.location.file}:${e.location.line}` : e.source}
            </span>
            <span className="muted"> imports </span>
            <span className="mono">
              {cycle.members.find((m) => m.id === e.target)?.label ?? e.target}
            </span>
            {e.detail && <span className="tag">{e.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
