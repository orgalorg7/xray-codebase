import type { DependencyView, DiffView, Summary } from "@xray/service";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
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
import { plural, shortPath, timeAgo } from "../format";
import type { EdgeLine } from "../map/draw";
import { useStore } from "../state";

const ADDED = "#2f9e44";
const CHANGED = "#f08c00";
const CYCLE = "#e03131";

/**
 * Time travel: how the architecture changed since a git revision. New import cycles,
 * dependencies between directories and API changes first; the map highlights what is new.
 */
export function ChangesPanel() {
  const { backend, store, frame, setOverlay, map } = useApp();
  const base = useStore(store, (s) => s.base) ?? "HEAD";
  const [input, setInput] = useState(base);
  useEffect(() => setInput(base), [base]);
  const revisions = useAsync(() => backend.revisions?.(), [backend]);
  const diff = useAsync(() => backend.diff?.(base), [backend, base]);
  const onMap = useMemo(() => new Set(map.nodes.map((n) => n.id)), [map]);

  // On the map: new code in green, changed API in orange, new cycles in red, new dependencies
  // as lines.
  useEffect(() => {
    const view = diff.data;
    if (!view) return;
    const colors = new Map<string, string>();
    for (const node of [...view.modules.added, ...view.symbols.added]) colors.set(node.id, ADDED);
    for (const change of view.api.changed) colors.set(change.node.id, CHANGED);
    for (const cycle of view.cycles.introduced)
      for (const node of cycle) colors.set(node.id, CYCLE);
    const edges: EdgeLine[] = view.dependencies.added.map((d) => ({
      source: d.source.id,
      target: d.target.id,
      kind: "imports",
      confidence: "exact",
      emphasis: view.cycles.introduced.some(
        (c) => c.some((n) => n.id === d.source.id) && c.some((n) => n.id === d.target.id),
      )
        ? "cut"
        : "normal",
    }));
    setOverlay({ highlight: { colors: filterTo(colors, onMap), dim: colors.size > 0 }, edges });
    return () => setOverlay(undefined);
  }, [diff.data, setOverlay, onMap]);

  const compare = (event: FormEvent) => {
    event.preventDefault();
    if (input.trim()) store.set({ base: input.trim() });
  };

  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">Changes</div>
        <h2 className="node-title">Since {shortPath(base, 40)}</h2>
        <p className="muted">
          How the architecture changed between a git revision and the working tree. New code is
          green, changed signatures orange, new import cycles red.
        </p>
      </header>
      <form className="controls-row changes-form" onSubmit={compare}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          list="xray-revisions"
          aria-label="Git revision to compare with"
          placeholder="main, HEAD~3, v1.2.0…"
          spellCheck={false}
        />
        <datalist id="xray-revisions">
          {revisions.data?.branches.map((b) => (
            <option key={b} value={b} />
          ))}
          {revisions.data?.commits.map((c) => (
            <option key={c.sha} value={c.sha.slice(0, 10)}>
              {c.subject}
            </option>
          ))}
        </datalist>
        <button type="submit">Compare</button>
      </form>
      {revisions.data && revisions.data.commits.length > 0 && (
        <p className="changes-quick">
          {[
            "HEAD",
            ...revisions.data.branches.filter((b) => b !== revisions.data?.current).slice(0, 3),
          ].map((rev) => (
            <button
              key={rev}
              type="button"
              className={rev === base ? "chip active" : "chip"}
              onClick={() => store.set({ base: rev })}
            >
              {rev === "HEAD" ? "uncommitted changes" : rev}
            </button>
          ))}
        </p>
      )}
      {diff.loading && (
        <Loading label={`Mapping ${base} to compare (a full scan of that revision)`} />
      )}
      {diff.error && <ErrorNote error={diff.error} />}
      {diff.data && <DiffDetails view={diff.data} onMap={onMap} />}
      {diff.data && (
        <p className="muted">
          Compared with {base} at {timeAgo(diff.data.before.scannedAt)}.{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => frame([...onMapIds(diff.data as DiffView, onMap)])}
          >
            Show all changes on the map
          </button>
        </p>
      )}
      {!backend.diff && <Empty>Comparing revisions needs a local repository.</Empty>}
    </div>
  );
}

function filterTo(colors: Map<string, string>, ids: Set<string>): Map<string, string> {
  return new Map([...colors].filter(([id]) => ids.has(id)));
}

function* onMapIds(view: DiffView, ids: Set<string>): Generator<string> {
  for (const node of [
    ...view.modules.added,
    ...view.symbols.added,
    ...view.api.changed.map((c) => c.node),
  ]) {
    if (ids.has(node.id)) yield node.id;
  }
}

function DiffDetails({ view, onMap }: { view: DiffView; onMap: Set<string> }) {
  const { theme, open } = useApp();
  /** A link for what exists now; plain text for what was removed. */
  const node = (s: Summary) =>
    onMap.has(s.id) ? (
      <NodeLink key={s.id} node={s} theme={theme} onOpen={open} />
    ) : (
      <div key={s.id} className="removed-node" title={s.id}>
        <span>{s.label}</span>
        {s.file && s.file !== s.label && (
          <span className="muted mono"> {shortPath(s.file, 40)}</span>
        )}
      </div>
    );
  const dep = (d: DependencyView) => (
    <div key={`${d.source.id} ${d.target.id}`} className="dep-row">
      {node(d.source)}
      <div className="dep-target">
        <span className="muted">→</span>
        {node(d.target)}
      </div>
    </div>
  );
  const nothing =
    view.modules.added.length +
      view.modules.removed.length +
      view.dependencies.added.length +
      view.dependencies.removed.length +
      view.symbols.added.length +
      view.symbols.removed.length ===
      0 && view.api.changed.length === 0;
  if (nothing) return <Empty>No architecture changes: the same files, dependencies and API.</Empty>;
  return (
    <>
      <div className="stats">
        <Stat
          label="files"
          added={view.modules.added.length}
          removed={view.modules.removed.length}
        />
        <Stat
          label="dependencies"
          added={view.dependencies.added.length}
          removed={view.dependencies.removed.length}
        />
        <Stat
          label="symbols"
          added={view.symbols.added.length}
          removed={view.symbols.removed.length}
        />
        <Stat
          label="import cycles"
          added={view.cycles.introduced.length}
          removed={view.cycles.resolved.length}
        />
      </div>
      {view.cycles.introduced.length > 0 && (
        <Section title="New import cycles" count={view.cycles.introduced.length}>
          {view.cycles.introduced.map((cycle, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cycles are listed by position
            <div key={i} className="cycle-row static">
              <span className="cycle-size">{cycle.length}</span>
              <span className="cycle-members">
                {cycle.map((m) => shortPath(m.label, 30)).join(" → ")}
              </span>
            </div>
          ))}
        </Section>
      )}
      <List
        title="New dependencies between directories"
        items={view.directories.added}
        render={dep}
      />
      <List title="Removed exported API" items={view.api.removed} render={node} />
      {view.api.changed.length > 0 && (
        <Section title="Changed signatures" count={view.api.changed.length}>
          <Limited
            items={view.api.changed}
            render={(c) => (
              <div key={c.node.id} className="signature-change">
                {node(c.node)}
                <code className="mono removed">{c.before}</code>
                <code className="mono">{c.after}</code>
              </div>
            )}
          />
        </Section>
      )}
      <List title="New routes" items={view.routes.added} render={node} />
      <List title="Removed routes" items={view.routes.removed} render={node} />
      {view.cycles.resolved.length > 0 && (
        <Section title="Resolved import cycles" count={view.cycles.resolved.length}>
          {view.cycles.resolved.map((cycle, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cycles are listed by position
            <div key={i} className="cycle-row static resolved">
              <span className="cycle-members">
                {cycle.map((m) => shortPath(m.label, 30)).join(" → ")}
              </span>
            </div>
          ))}
        </Section>
      )}
      {view.coupling.length > 0 && (
        <Section title="Coupling shifts" count={view.coupling.length}>
          <Limited
            items={view.coupling}
            render={(c) => (
              <div key={c.node.id} className="dep-row">
                {node(c.node)}
                <span className="muted">
                  {plural(c.before, "importer")} → {c.after}
                </span>
              </div>
            )}
          />
        </Section>
      )}
      <List title="New dependencies between files" items={view.dependencies.added} render={dep} />
      <List
        title="Removed dependencies between files"
        items={view.dependencies.removed}
        render={dep}
      />
      <List title="Added files" items={view.modules.added} render={node} />
      <List title="Removed files" items={view.modules.removed} render={node} />
      <List title="Added symbols" items={view.symbols.added} render={node} />
      <List title="Removed symbols" items={view.symbols.removed} render={node} />
    </>
  );
}

function List<T>({
  title,
  items,
  render,
}: {
  title: string;
  items: T[];
  render: (item: T, i: number) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <Section title={title} count={items.length}>
      <Limited items={items} render={render} />
    </Section>
  );
}

function Stat({ label, added, removed }: { label: string; added: number; removed: number }) {
  return (
    <div className="stat">
      <div className="stat-value">
        <span className="added">+{added}</span> <span className="removed">−{removed}</span>
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
