import type { ImpactView, Summary } from "./types.js";

/** First line of every impact comment, so a bot can find and update its own comment. */
export const IMPACT_MARKER = "<!-- xray-impact -->";

export type ImpactMarkdownOptions = {
  /** URL prefix for files (`https://github.com/o/r/blob/<sha>/`); paths and `#L<line>` follow. */
  link?: string;
  /** Items listed per section; the rest are counted. */
  limit?: number;
};

const RISK_ICONS = { high: "🔴", medium: "🟠", low: "🟢" } as const;

const escapeMarkdown = (text: string): string => text.replace(/([\\`*_[\]<>|])/g, "\\$1");

/**
 * The blast radius of a change as GitHub-flavored Markdown, for pull request comments: risk,
 * what changed, affected entry points, tests to run and direct dependents.
 */
export function impactMarkdown(
  changed: readonly Summary[],
  report: ImpactView,
  options: ImpactMarkdownOptions = {},
): string {
  const limit = options.limit ?? 30;
  const item = (node: Summary, note = ""): string => {
    const name = `\`${node.label.replaceAll("`", "'")}\``;
    const place = node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : "";
    const linked =
      options.link && node.file
        ? `[${name}](${options.link}${node.file.split("/").map(encodeURIComponent).join("/")}${node.line ? `#L${node.line}` : ""})`
        : name;
    return `- ${linked} ${node.kind}${place && node.label !== node.file ? ` · ${escapeMarkdown(place)}` : ""}${note}`;
  };
  const section = (title: string, lines: string[], open = false): string[] => {
    if (lines.length === 0) return [];
    const shown = lines.slice(0, limit);
    const more = lines.length - shown.length;
    return [
      `<details${open ? " open" : ""}><summary><b>${title} (${lines.length})</b></summary>`,
      "",
      ...shown,
      ...(more > 0 ? [`- …and ${more} more`] : []),
      "",
      "</details>",
      "",
    ];
  };
  const guessed = (confidence: string) => (confidence === "exact" ? "" : ` _(${confidence})_`);

  const lines = [IMPACT_MARKER, "### xray: blast radius of this change", ""];
  if (changed.length === 0) {
    lines.push("No changes to TypeScript, JavaScript or Python code.");
    return `${lines.join("\n")}\n`;
  }
  const { risk } = report;
  const modules = report.modules.length;
  lines.push(
    `${RISK_ICONS[risk.level]} **${risk.level.toUpperCase()} risk** (${risk.score}/100)${risk.reasons.length > 0 ? `: ${escapeMarkdown(risk.reasons.join("; "))}` : ""}`,
    "",
    `| Changed | Reaches | In files | Entry points | Tests |`,
    `| ---: | ---: | ---: | ---: | ---: |`,
    `| ${changed.length} | ${report.impacted.length}${report.truncated ? "+" : ""} | ${modules} | ${report.entryPoints.length} | ${report.tests.length} |`,
    "",
  );
  if (report.rings.length > 0) {
    lines.push(
      `By distance: ${report.rings.map((r) => `${r.ids.length} at ${r.depth}`).join(" · ")}`,
      "",
    );
  }
  lines.push(
    ...section(
      "Changed",
      changed.map((node) => item(node)),
    ),
    ...section(
      "Entry points affected",
      report.entryPoints.map((e) => item(e.node, guessed(e.confidence))),
      true,
    ),
    ...section(
      "Tests to run",
      report.tests.map((t) => item(t.node, guessed(t.confidence))),
    ),
    ...section(
      "Direct dependents",
      report.impacted.filter((n) => n.depth === 1).map((n) => item(n.node, guessed(n.confidence))),
    ),
  );
  lines.push(
    "<sub>Static analysis by xray: nothing was run. Links marked <i>inferred</i> or <i>heuristic</i> are likely but not certain.</sub>",
  );
  return `${lines.join("\n")}\n`;
}
