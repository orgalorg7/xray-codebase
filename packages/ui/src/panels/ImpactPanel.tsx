import type { Summary } from "@xray/service";
import { useEffect, useMemo } from "react";
import {
  ConfidenceMark,
  Empty,
  ErrorNote,
  Limited,
  Loading,
  NodeLink,
  Section,
  useAsync,
} from "../components/common";
import { NodePicker } from "../components/NodePicker";
import { useApp } from "../context";
import { edgeVerb, plural } from "../format";
import { ringColor } from "../map/colors";
import { useStore } from "../state";

/** Blast radius: everything that may break if a piece of code changes. */
export function ImpactPanel() {
  const { backend, store, theme, open, frame, setOverlay } = useApp();
  const target = useStore(store, (s) => s.impactTarget);
  const depth = useStore(store, (s) => s.impactDepth);
  const heuristic = useStore(store, (s) => s.impactHeuristic);
  const targetNode = useAsync(
    () => (target ? backend.resolve(target).then((r) => r[0]) : undefined),
    [backend, target],
  );
  const report = useAsync(
    () =>
      target
        ? backend.impact({ ids: [target], ...(depth === undefined ? {} : { depth }), heuristic })
        : undefined,
    [backend, target, depth, heuristic],
  );
  const data = report.data;
  const maxDepth = data?.rings.at(-1)?.depth ?? 1;

  useEffect(() => {
    if (!data || !target) return;
    const colors = new Map<string, string>([[target, "#e03131"]]);
    for (const n of data.impacted) colors.set(n.id, ringColor(n.depth, maxDepth));
    setOverlay({ highlight: { colors, dim: true } });
    frame([target, ...data.impacted.slice(0, 200).map((n) => n.id)]);
    return () => setOverlay(undefined);
  }, [data, target, maxDepth, setOverlay, frame]);

  const byRing = useMemo(
    () =>
      data?.rings.map((ring) => ({
        depth: ring.depth,
        nodes: data.impacted.filter((n) => n.depth === ring.depth),
      })) ?? [],
    [data],
  );

  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">Blast radius</div>
        <h2 className="node-title">What breaks if this changes?</h2>
      </header>
      <NodePicker
        label="Change"
        value={targetNode.data as Summary | undefined}
        placeholder="Search the code you plan to change"
        onPick={(id) => store.set({ impactTarget: id })}
      />
      <div className="controls-row">
        <label>
          Depth{" "}
          <select
            value={depth ?? ""}
            onChange={(e) =>
              store.set({ impactDepth: e.target.value === "" ? undefined : Number(e.target.value) })
            }
          >
            <option value="">all</option>
            {[1, 2, 3, 4, 5, 8].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label title="Include links xray guessed by name">
          <input
            type="checkbox"
            checked={heuristic}
            onChange={(e) => store.set({ impactHeuristic: e.target.checked })}
          />{" "}
          include guesses
        </label>
      </div>

      {!target && <Empty>Pick something above, or use “Blast radius” on any selected node.</Empty>}
      {report.loading && target && <Loading label="Tracing dependents" />}
      {report.error && <ErrorNote error={report.error} />}
      {data && (
        <>
          <div className={`risk risk-${data.risk.level}`}>
            <div className="risk-score">
              <span>{data.risk.level} risk</span>
              <strong>{data.risk.score}</strong>
            </div>
            <ul>
              {data.risk.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          {data.impacted.length === 0 ? (
            <Empty>Nothing in the repository depends on this.</Empty>
          ) : (
            <>
              <ul className="rings" aria-label="Dependents by distance">
                {data.rings.map((r) => (
                  <li
                    key={r.depth}
                    className="ring-bar"
                    title={`${r.ids.length} at distance ${r.depth}`}
                  >
                    <span className="swatch" style={{ background: ringColor(r.depth, maxDepth) }} />
                    {r.depth === 1 ? "direct" : `${r.depth} hops`}: {r.ids.length}
                  </li>
                ))}
              </ul>
              {data.entryPoints.length > 0 && (
                <Section title="Entry points affected" count={data.entryPoints.length}>
                  <Limited
                    items={data.entryPoints}
                    render={(n) => (
                      <NodeLink
                        key={n.id}
                        node={n.node}
                        theme={theme}
                        onOpen={open}
                        detail={<ConfidenceMark confidence={n.confidence} />}
                      />
                    )}
                  />
                </Section>
              )}
              {data.tests.length > 0 && (
                <Section title="Tests to run" count={data.tests.length} defaultOpen={false}>
                  <Limited
                    items={data.tests}
                    render={(n) => (
                      <NodeLink
                        key={n.id}
                        node={n.node}
                        theme={theme}
                        onOpen={open}
                        detail={<ConfidenceMark confidence={n.confidence} />}
                      />
                    )}
                  />
                </Section>
              )}
              {byRing.map((ring) => (
                <Section
                  key={ring.depth}
                  title={ring.depth === 1 ? "Direct dependents" : `${ring.depth} steps away`}
                  count={ring.nodes.length}
                  defaultOpen={ring.depth <= 2}
                >
                  <Limited
                    items={ring.nodes}
                    render={(n) => (
                      <NodeLink
                        key={n.id}
                        node={n.node}
                        theme={theme}
                        onOpen={open}
                        detail={
                          <>
                            <span className="muted">
                              {n.via === "overrides" ? "via dispatch" : edgeVerb(n.via, true)}
                            </span>
                            <ConfidenceMark confidence={n.confidence} />
                          </>
                        }
                      />
                    )}
                  />
                </Section>
              ))}
              {data.truncated && <p className="muted">Showing the first 2000 dependents.</p>}
              <p className="muted footnote">{plural(data.modules.length, "file")} affected.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
