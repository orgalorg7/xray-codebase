import type { EdgeKind } from "@xray/schema";
import type { EdgeView, NodeDetails } from "@xray/service";
import { useEffect, useMemo } from "react";
import {
  ConfidenceMark,
  ErrorNote,
  KindDot,
  Limited,
  Loading,
  NodeLink,
  Section,
  useAsync,
} from "../components/common";
import { useApp } from "../context";
import { edgeVerb, formatCount, kindLabel, plural, timeAgo } from "../format";
import type { EdgeLine } from "../map/draw";
import { SourcePreview } from "./SourcePreview";

/** Relations listed in this order, outgoing then incoming. */
const GROUPS: { kinds: EdgeKind[]; out: string; in: string }[] = [
  { kinds: ["handles"], out: "Handled by", in: "Entry points" },
  { kinds: ["calls", "instantiates"], out: "Calls", in: "Called by" },
  { kinds: ["references", "type-of", "decorates"], out: "Uses", in: "Used by" },
  { kinds: ["extends", "implements", "overrides"], out: "Inherits from", in: "Inherited by" },
  { kinds: ["imports", "re-exports", "exports"], out: "Imports", in: "Imported by" },
  { kinds: ["tests"], out: "Tests", in: "Tested by" },
];

const DRAWN: EdgeKind[] = [
  "calls",
  "instantiates",
  "handles",
  "references",
  "extends",
  "implements",
  "overrides",
  "imports",
];

/** Everything about one node: what it is, its code, and what it is connected to. */
export function NodePanel({ id }: { id: string }) {
  const { backend, store, theme, open, setOverlay } = useApp();
  const details = useAsync(() => backend.node(id), [backend, id]);

  // Show the node's relations on the map.
  useEffect(() => {
    const d = details.data;
    if (!d) return;
    const edges: EdgeLine[] = [
      ...d.outgoing
        .filter((e) => DRAWN.includes(e.kind))
        .map((e) => ({ source: id, target: e.other.id, kind: e.kind, confidence: e.confidence })),
      ...d.incoming
        .filter((e) => DRAWN.includes(e.kind))
        .map((e) => ({ source: e.other.id, target: id, kind: e.kind, confidence: e.confidence })),
    ].slice(0, 120);
    setOverlay({ edges });
    return () => setOverlay(undefined);
  }, [details.data, id, setOverlay]);

  if (details.loading && !details.data) return <Loading />;
  if (details.error) return <ErrorNote error={details.error} />;
  const d = details.data;
  if (!d)
    return (
      <div className="empty">
        This node is no longer in the graph. It may have been removed by the last scan.
      </div>
    );
  const node = d.node;
  const loc = node.location;
  const isFile = node.kind === "module";

  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">
          <KindDot kind={node.kind} theme={theme} /> {kindLabel(node.kind)}
          {node.exported && <span className="tag">exported</span>}
          {node.language && <span className="tag">{node.language}</span>}
        </div>
        <h2 className="node-title">{node.kind === "module" ? node.name : node.qualifiedName}</h2>
        <nav className="breadcrumbs" aria-label="Location">
          {[...d.ancestors].reverse().map((a) => (
            <button key={a.id} type="button" className="crumb" onClick={() => open(a.id)}>
              {a.name}
            </button>
          ))}
        </nav>
        {node.signature && <code className="signature">{node.signature}</code>}
        {node.doc && <p className="doc">{node.doc}</p>}
      </header>

      <div className="stats">
        <Stat label="lines" value={d.metrics.lines} />
        <Stat label="depend on it" value={d.metrics.fanIn} />
        <Stat label="it depends on" value={d.metrics.fanOut} />
        {d.metrics.rank !== undefined && (
          <Stat label="centrality rank" value={`#${d.metrics.rank}`} />
        )}
      </div>

      <div className="actions">
        <button
          type="button"
          onClick={() => store.set({ mode: "impact", impactTarget: id })}
          title="What breaks if this changes (I)"
        >
          Blast radius
        </button>
        <button
          type="button"
          onClick={() => store.set({ mode: "directions", from: id, route: 0 })}
          title="Find how this reaches something (D)"
        >
          Route from here
        </button>
        <button type="button" onClick={() => store.set({ mode: "directions", to: id, route: 0 })}>
          Route to here
        </button>
        {!isFile && (
          <>
            <button type="button" onClick={() => store.set({ tree: { id, direction: "out" } })}>
              Call tree
            </button>
            <button type="button" onClick={() => store.set({ tree: { id, direction: "in" } })}>
              Callers
            </button>
          </>
        )}
        <button type="button" onClick={() => navigator.clipboard?.writeText(id)} title={id}>
          Copy ID
        </button>
      </div>

      {loc && !isFile && node.kind !== "route" && node.kind !== "cli-command" && (
        <Section title="Source">
          <SourcePreview file={loc.file} line={loc.line} endLine={loc.endLine} />
        </Section>
      )}

      <Relations details={d} />

      {d.children.length > 0 && (
        <Section title={isFile ? "Defines" : "Members"} count={d.children.length}>
          <Limited
            items={d.children}
            limit={15}
            render={(c) => (
              <NodeLink key={c.id} node={c} theme={theme} onOpen={open} showPath={false} />
            )}
          />
        </Section>
      )}

      {d.git && (
        <Section title="History" defaultOpen={false}>
          <p className="muted">
            {plural(d.git.commits, "commit")} · {plural(d.git.authors.length, "author")} · last
            changed {timeAgo(d.git.lastChanged)}
          </p>
          <p className="muted">
            +{formatCount(d.git.additions)} / −{formatCount(d.git.deletions)} lines ·{" "}
            {d.git.authors.slice(0, 3).join(", ")}
          </p>
          {d.coChanges && d.coChanges.length > 0 && (
            <>
              <h4>Usually changes with</h4>
              {d.coChanges.map((c) => (
                <div key={c.file} className="row">
                  <span className="mono">{c.file}</span>
                  <span className="muted">{Math.round(c.confidence * 100)}%</span>
                </div>
              ))}
            </>
          )}
        </Section>
      )}
      {d.district && <p className="muted footnote">District: {d.district.name}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <div className="stat-value">{typeof value === "number" ? formatCount(value) : value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Relations({ details }: { details: NodeDetails }) {
  const { theme, open } = useApp();
  const groups = useMemo(() => {
    const out: { title: string; items: EdgeView[]; outgoing: boolean }[] = [];
    for (const group of GROUPS) {
      const outgoing = dedupe(details.outgoing.filter((e) => group.kinds.includes(e.kind)));
      const incoming = dedupe(details.incoming.filter((e) => group.kinds.includes(e.kind)));
      if (outgoing.length > 0) out.push({ title: group.out, items: outgoing, outgoing: true });
      if (incoming.length > 0) out.push({ title: group.in, items: incoming, outgoing: false });
    }
    return out;
  }, [details]);
  if (groups.length === 0) return <p className="muted">No dependencies in either direction.</p>;
  return (
    <>
      {groups.map((g) => (
        <Section key={`${g.title}-${g.outgoing}`} title={g.title} count={g.items.length}>
          <Limited
            items={g.items}
            render={(e) => (
              <NodeLink
                key={`${e.kind}-${e.other.id}`}
                node={e.other}
                theme={theme}
                onOpen={open}
                detail={
                  <>
                    {g.items.some((x) => x.kind !== e.kind) && (
                      <span className="muted">{edgeVerb(e.kind, g.outgoing)}</span>
                    )}
                    {e.detail && <span className="tag">{e.detail}</span>}
                    <ConfidenceMark confidence={e.confidence} />
                  </>
                }
              />
            )}
          />
        </Section>
      ))}
      {details.truncated && <p className="muted">Showing the first 500 relations.</p>}
    </>
  );
}

/** One row per (kind, other node): several call sites of the same callee collapse. */
function dedupe(edges: EdgeView[]): EdgeView[] {
  const seen = new Map<string, EdgeView>();
  for (const e of edges) {
    const key = `${e.kind}\u0000${e.other.id}`;
    const previous = seen.get(key);
    // Keep the most certain edge when sites disagree.
    if (!previous || rank(e.confidence) < rank(previous.confidence)) seen.set(key, e);
  }
  return [...seen.values()];
}

const rank = (c: EdgeView["confidence"]) => (c === "exact" ? 0 : c === "inferred" ? 1 : 2);
