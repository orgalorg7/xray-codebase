import type { Language } from "@xray/schema";
import { useEffect, useState } from "react";
import { ErrorNote, Loading, useAsync } from "../components/common";
import { useApp } from "../context";
import { highlight, type Token } from "../highlight";

/** Source lines around a declaration, syntax highlighted, with the declaration marked. */
export function SourcePreview({
  file,
  line,
  endLine,
}: {
  file: string;
  line: number;
  endLine?: number | undefined;
}) {
  const { backend, theme, editorLink, openInEditor } = useApp();
  const [expanded, setExpanded] = useState(false);
  const span = (endLine ?? line) - line + 1;
  const context = 3;
  const limit = expanded ? 2000 : 60;
  const start = Math.max(1, line - context);
  const end = line + Math.min(span, limit) + context - 1;
  const source = useAsync(() => backend.source(file, start, end), [backend, file, start, end]);
  const [tokens, setTokens] = useState<Token[][] | undefined>();

  useEffect(() => {
    setTokens(undefined);
    const lines = source.data?.lines;
    if (!lines) return;
    let current = true;
    highlight(lines.join("\n"), source.data?.language as Language | undefined, theme).then(
      (t) => current && setTokens(t),
    );
    return () => {
      current = false;
    };
  }, [source.data, theme]);

  if (source.loading) return <Loading label="Loading source" />;
  if (source.error) return <ErrorNote error={source.error} />;
  if (!source.data) return <div className="empty">Source is not available in this view.</div>;
  const first = source.data.startLine;
  const rows: Token[][] = tokens ?? source.data.lines.map((l) => [{ content: l }]);
  const link = editorLink(file, line);
  return (
    <div className="source">
      <div className="source-head">
        <span className="mono">
          {file}:{line}
        </span>
        {openInEditor ? (
          <button type="button" className="link-button" onClick={() => openInEditor(file, line)}>
            Open in editor
          </button>
        ) : (
          link && (
            <a href={link} className="link-button">
              Open in editor
            </a>
          )
        )}
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable code must be reachable by keyboard */}
      <pre className="code" tabIndex={0}>
        {rows.map((row, i) => {
          const n = first + i;
          const inside = n >= line && n <= (endLine ?? line);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            <div key={i} className={inside ? "code-line code-line-focus" : "code-line"}>
              <span className="code-gutter">{n}</span>
              <span>
                {row.map((token, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                  <span key={j} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </pre>
      {span > 60 && (
        <button type="button" className="link-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show all ${span} lines`}
        </button>
      )}
    </div>
  );
}
