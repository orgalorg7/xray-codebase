import type { SearchView } from "@xray/service";
import { forwardRef, useEffect, useState } from "react";
import { useApp } from "../context";
import { useStore } from "../state";
import { KindDot } from "./common";

/**
 * The omnibox. Typing shows the best matches; Enter on a match opens it, Enter on the text
 * searches for the feature and shows its territory.
 */
export const SearchBox = forwardRef<HTMLInputElement>(function SearchBox(_props, ref) {
  const { backend, store, theme, open } = useApp();
  const query = useStore(store, (s) => s.query);
  const [results, setResults] = useState<SearchView | undefined>();
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      backend.search(query, 8).then((r) => {
        if (!current) return;
        setResults(r);
        setActive(-1);
      });
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, backend]);

  const hits = results?.hits ?? [];
  const showList = focused && query.trim().length >= 2;

  const submit = () => {
    const hit = hits[active];
    if (hit) {
      open(hit.id);
      store.set({ query: "" });
    } else if (query.trim()) {
      store.set({ mode: "explore", territory: query.trim(), selected: undefined, tree: undefined });
    }
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div className="search">
      <input
        ref={ref}
        type="search"
        value={query}
        placeholder="Search code or ask “where is login handled?”   ( / )"
        aria-label="Search the codebase"
        role="combobox"
        aria-expanded={showList}
        aria-controls="search-results"
        aria-activedescendant={active >= 0 ? `search-hit-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => store.set({ query: e.target.value })}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(hits.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(-1, a - 1));
          } else if (e.key === "Enter") submit();
          else if (e.key === "Escape") {
            store.set({ query: "" });
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {showList && (
        <div className="search-results" id="search-results" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={active === -1}
            className={active === -1 ? "search-hit active" : "search-hit"}
            onMouseDown={(e) => {
              e.preventDefault();
              setActive(-1);
              submit();
            }}
          >
            <span className="kind-dot">⌕</span> Show everything about “{query.trim()}”
          </button>
          {hits.map((hit, i) => (
            <button
              key={hit.id}
              id={`search-hit-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? "search-hit active" : "search-hit"}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                open(hit.id);
                store.set({ query: "" });
              }}
            >
              <KindDot kind={hit.node.kind} theme={theme} />
              <span className="search-hit-name">{hit.node.label}</span>
              {hit.node.file && hit.node.kind !== "module" && (
                <span className="search-hit-path">{hit.node.file}</span>
              )}
            </button>
          ))}
          {results && hits.length === 0 && <div className="search-empty">No matches</div>}
        </div>
      )}
    </div>
  );
});
