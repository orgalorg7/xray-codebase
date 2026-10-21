import { useState } from "react";
import { ErrorNote, Limited, Loading, NodeLink, Section, useAsync } from "../components/common";
import { useApp } from "../context";
import { formatCount, plural } from "../format";

/** Where the codebase needs attention: hotspots, dead code, unused exports, districts, churn. */
export function InsightsPanel() {
  const { backend, theme, open, setOverlay, frame, map } = useApp();
  const insights = useAsync(() => backend.insights(), [backend]);
  const [district, setDistrict] = useState<number | undefined>();

  const showDistrict = (id: number) => {
    if (district === id) {
      setDistrict(undefined);
      setOverlay(undefined);
      return;
    }
    setDistrict(id);
    const members = map.nodes
      .filter((n) => n.kind === "module" && n.district === id)
      .map((n) => n.id);
    setOverlay({ highlight: { colors: new Map(members.map((m) => [m, "#7048e8"])), dim: true } });
    frame(members);
  };

  if (insights.loading) return <Loading label="Analyzing" />;
  if (insights.error) return <ErrorNote error={insights.error} />;
  const data = insights.data;
  if (!data) return null;
  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">Insights</div>
        <h2 className="node-title">Where to look</h2>
      </header>

      <Section title="Hotspot files" count={data.hotspots.modules.length}>
        <p className="muted">
          Very large or very connected files: change them carefully, split them when you can.
        </p>
        <Limited
          items={data.hotspots.modules}
          limit={8}
          render={(m) => (
            <NodeLink
              key={m.id}
              node={m.node}
              theme={theme}
              onOpen={open}
              detail={
                <span className="muted">
                  {formatCount(m.lines)} lines · {m.fanIn} in
                </span>
              }
            />
          )}
        />
      </Section>

      {data.hotspots.classes.length > 0 && (
        <Section title="Large classes" count={data.hotspots.classes.length}>
          <Limited
            items={data.hotspots.classes}
            limit={8}
            render={(c) => (
              <NodeLink
                key={c.id}
                node={c.node}
                theme={theme}
                onOpen={open}
                detail={<span className="muted">{plural(c.methods, "method")}</span>}
              />
            )}
          />
        </Section>
      )}

      <Section
        title="Possibly dead code"
        count={data.deadCode.length}
        defaultOpen={data.deadCode.length <= 30}
      >
        <p className="muted">
          Nothing reachable uses these. Check for dynamic use (reflection, string lookups) before
          deleting.
        </p>
        <Limited
          items={data.deadCode}
          render={(d) => (
            <NodeLink
              key={d.id}
              node={d}
              theme={theme}
              onOpen={open}
              detail={<span className="muted">{plural(d.lines, "line")}</span>}
            />
          )}
        />
      </Section>

      {data.unusedExports.length > 0 && (
        <Section title="Unused exports" count={data.unusedExports.length} defaultOpen={false}>
          <p className="muted">Exported, but no other file in the repository uses them.</p>
          <Limited
            items={data.unusedExports}
            render={(n) => <NodeLink key={n.id} node={n} theme={theme} onOpen={open} />}
          />
        </Section>
      )}

      <Section title="Districts" count={data.districts.length} defaultOpen={false}>
        <p className="muted">
          Groups of files that depend on each other more than on the rest. Click one to see it.
        </p>
        {data.districts.map((d) => (
          <button
            key={d.id}
            type="button"
            className={district === d.id ? "district-row active" : "district-row"}
            onClick={() => showDistrict(d.id)}
          >
            <span
              className="swatch"
              style={{ background: `hsl(${(d.id * 137.508 + 200) % 360} 45% 60%)` }}
            />
            <span>{d.name}</span>
            <span className="muted">{plural(d.modules, "file")}</span>
          </button>
        ))}
      </Section>

      {data.churn.length > 0 && (
        <Section title="Most changed files" count={data.churn.length} defaultOpen={false}>
          {data.churn.slice(0, 20).map((c) => (
            <div key={c.file} className="row">
              <span className="mono">{c.file}</span>
              <span className="muted">
                {plural(c.commits, "commit")} · {plural(c.authors, "author")}
              </span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
