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

/** Where a feature lives: the best matches, their files, and the entry points and tests around them. */
export function TerritoryPanel({ query }: { query: string }) {
  const { backend, store, theme, open, frame, setOverlay } = useApp();
  const result = useAsync(() => backend.search(query, 30), [backend, query]);

  useEffect(() => {
    const hits = result.data?.hits;
    if (!hits || hits.length === 0) return;
    const colors = new Map<string, string>();
    for (const hit of hits) colors.set(hit.id, hit.lexical > 0 ? "#f59f00" : "#fcc419");
    setOverlay({ highlight: { colors, dim: true } });
    frame(hits.slice(0, 12).map((h) => h.id));
    return () => setOverlay(undefined);
  }, [result.data, setOverlay, frame]);

  if (result.loading) return <Loading label="Searching" />;
  if (result.error) return <ErrorNote error={result.error} />;
  const data = result.data;
  return (
    <div className="panel-body">
      <header className="node-head">
        <div className="node-kind">Feature search</div>
        <h2 className="node-title">“{query}”</h2>
        <button
          type="button"
          className="link-button"
          onClick={() => store.set({ territory: undefined, query: "" })}
        >
          Clear search
        </button>
      </header>
      {!data || data.hits.length === 0 ? (
        <Empty>
          Nothing matches {data?.terms.length ? `“${data.terms.join(" ")}”` : "that"}. Try the words
          the code would use, like a function or file name.
        </Empty>
      ) : (
        <>
          <Section title="Best matches" count={data.hits.length}>
            <Limited
              items={data.hits}
              limit={15}
              render={(hit) => (
                <NodeLink
                  key={hit.id}
                  node={hit.node}
                  theme={theme}
                  onOpen={open}
                  detail={
                    hit.lexical === 0 ? (
                      <span
                        className="tag"
                        title="Not a name match: closely connected to the matches"
                      >
                        related
                      </span>
                    ) : undefined
                  }
                />
              )}
            />
          </Section>
          <Section title="Files" count={data.territory.modules.length}>
            <Limited
              items={data.territory.modules}
              limit={8}
              render={(m) => <NodeLink key={m.node.id} node={m.node} theme={theme} onOpen={open} />}
            />
          </Section>
          {data.territory.entryPoints.length > 0 && (
            <Section title="Entry points that lead here" count={data.territory.entryPoints.length}>
              {data.territory.entryPoints.map((n) => (
                <NodeLink key={n.id} node={n} theme={theme} onOpen={open} />
              ))}
            </Section>
          )}
          {data.territory.tests.length > 0 && (
            <Section
              title="Tests that exercise it"
              count={data.territory.tests.length}
              defaultOpen={false}
            >
              <Limited
                items={data.territory.tests}
                render={(n) => <NodeLink key={n.id} node={n} theme={theme} onOpen={open} />}
              />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
