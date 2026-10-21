import type { Confidence } from "@xray/schema";
import type { Summary } from "@xray/service";
import { type ReactNode, useEffect, useState } from "react";
import { confidenceGlyph, confidenceLabel, kindGlyph, kindLabel } from "../format";
import { kindColor, type Theme } from "../map/colors";

export type Async<T> = { data: T | undefined; error: Error | undefined; loading: boolean };

/** Runs `load` whenever `deps` change, ignoring results that arrive after a newer request. */
export function useAsync<T>(load: () => Promise<T> | undefined, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  useEffect(() => {
    let current = true;
    const promise = load();
    if (!promise) {
      setState({ data: undefined, error: undefined, loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: undefined }));
    promise.then(
      (data) => current && setState({ data, error: undefined, loading: false }),
      (error: unknown) =>
        current &&
        setState({
          data: undefined,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        }),
    );
    return () => {
      current = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: forwarded from the caller, like useEffect's own list
  }, deps);
  return state;
}

export function KindDot({ kind, theme }: { kind: Summary["kind"]; theme: Theme }) {
  return (
    <span
      className="kind-dot"
      style={{ background: kindColor(kind, theme) }}
      title={kindLabel(kind)}
    >
      {kindGlyph(kind)}
    </span>
  );
}

export function ConfidenceMark({ confidence }: { confidence: Confidence }) {
  if (confidence === "exact") return null;
  return (
    <span className={`confidence confidence-${confidence}`} title={confidenceLabel[confidence]}>
      {confidenceGlyph[confidence]}
    </span>
  );
}

/** A clickable reference to a node: selects it and flies the map there. */
export function NodeLink({
  node,
  theme,
  onOpen,
  detail,
  showPath = true,
}: {
  node: Summary;
  theme: Theme;
  onOpen: (id: string) => void;
  detail?: ReactNode;
  showPath?: boolean;
}) {
  const path =
    node.kind === "module" || node.kind === "directory" || node.kind === "package"
      ? undefined
      : node.file;
  return (
    <button type="button" className="node-link" onClick={() => onOpen(node.id)} title={node.id}>
      <KindDot kind={node.kind} theme={theme} />
      <span className="node-link-text">
        <span className="node-link-name">{node.label}</span>
        {showPath && path && (
          <span className="node-link-path">
            {path}
            {node.line ? `:${node.line}` : ""}
          </span>
        )}
      </span>
      {detail && <span className="node-link-detail">{detail}</span>}
    </button>
  );
}

export function Section({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="section" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {count !== undefined && <span className="count">{count}</span>}
      </summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function ErrorNote({ error }: { error: Error }) {
  return (
    <div className="error-note" role="alert">
      {error.message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Shows at most `limit` items with a "show all" toggle. */
export function Limited<T>({
  items,
  limit = 12,
  render,
}: {
  items: T[];
  limit?: number;
  render: (item: T, i: number) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, limit);
  return (
    <>
      {shown.map(render)}
      {items.length > limit && (
        <button type="button" className="link-button" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}
