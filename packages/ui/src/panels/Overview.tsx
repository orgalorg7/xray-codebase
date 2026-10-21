import { useMemo } from "react";
import { NodeLink, Section } from "../components/common";
import { useApp } from "../context";
import { formatCount, plural, timeAgo } from "../format";

const LANGUAGE_NAMES = { ts: "TypeScript", js: "JavaScript", py: "Python" } as const;

/** The repository at a glance, shown when nothing is selected. */
export function Overview() {
  const { meta, map, theme, open, store } = useApp();
  const central = useMemo(
    () =>
      map.nodes
        .filter((n) => n.rank !== undefined && n.kind !== "variable" && n.kind !== "property")
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
        .slice(0, 8),
    [map],
  );
  const entryPoints = useMemo(
    () => map.nodes.filter((n) => n.kind === "route" || n.kind === "cli-command").slice(0, 200),
    [map],
  );
  const { stats } = meta;

  return (
    <div className="panel-body">
      <header className="node-head">
        <h2 className="node-title">{meta.name}</h2>
        <p className="muted">Scanned {timeAgo(meta.scannedAt)}</p>
      </header>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{formatCount(stats.files)}</div>
          <div className="stat-label">files</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatCount(stats.symbols)}</div>
          <div className="stat-label">symbols</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatCount(stats.edges)}</div>
          <div className="stat-label">links</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatCount(stats.entryPoints)}</div>
          <div className="stat-label">entry points</div>
        </div>
      </div>
      <p className="muted">
        {Object.entries(stats.languages)
          .map(
            ([lang, n]) =>
              `${LANGUAGE_NAMES[lang as keyof typeof LANGUAGE_NAMES]} ${plural(n ?? 0, "file")}`,
          )
          .join(" · ")}
        {stats.tests > 0 && ` · ${plural(stats.tests, "test")}`}
      </p>

      <div className="hint-card">
        <strong>Find your way:</strong> search for a feature ("where is login handled"), click
        anything on the map, or press <kbd>?</kbd> for shortcuts.
      </div>

      {central.length > 0 && (
        <Section title="Load-bearing code" count={central.length}>
          <p className="muted">What the most code depends on, directly or indirectly.</p>
          {central.map((n) => (
            <NodeLink
              key={n.id}
              node={n}
              theme={theme}
              onOpen={open}
              detail={<span className="muted">{n.fanIn} in</span>}
            />
          ))}
        </Section>
      )}

      {entryPoints.length > 0 && (
        <Section
          title="Entry points"
          count={entryPoints.length}
          defaultOpen={entryPoints.length <= 20}
        >
          {entryPoints.slice(0, 50).map((n) => (
            <NodeLink key={n.id} node={n} theme={theme} onOpen={open} />
          ))}
        </Section>
      )}

      {map.districts.length > 1 && (
        <Section title="Districts" count={map.districts.length} defaultOpen={false}>
          <p className="muted">Groups of files that mostly depend on each other.</p>
          {map.districts.slice(0, 15).map((d) => (
            <div key={d.id} className="row">
              <span
                className="swatch"
                style={{ background: `hsl(${(d.id * 137.508 + 200) % 360} 45% 60%)` }}
              />
              <span>{d.name}</span>
            </div>
          ))}
          <button
            type="button"
            className="link-button"
            onClick={() => store.set({ mode: "insights" })}
          >
            More in Insights
          </button>
        </Section>
      )}

      {meta.diagnostics.count > 0 && (
        <Section title="Scan notes" count={meta.diagnostics.count} defaultOpen={false}>
          {meta.diagnostics.sample.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no identity
            <div key={i} className={`diagnostic diagnostic-${d.severity}`}>
              {d.file && <span className="mono">{d.file}: </span>}
              {d.message}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
