import type { DependencyView, DiffView, ImpactView, Summary } from "./types.js";

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
    lines.push("This change touches no mapped code (only docs, configuration or other files).");
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

/**
 * An architecture diff as GitHub-flavored Markdown: what a reviewer should look at first (new
 * import cycles, new dependencies between directories, exported API changes, routes), then the
 * full lists.
 */
export function diffMarkdown(
  view: DiffView,
  options: ImpactMarkdownOptions & { heading?: boolean } = {},
): string {
  const limit = options.limit ?? 30;
  const link = (node: Summary): string => {
    const name = `\`${node.label.replaceAll("`", "'")}\``;
    return options.link && node.file
      ? `[${name}](${options.link}${node.file.split("/").map(encodeURIComponent).join("/")}${node.line ? `#L${node.line}` : ""})`
      : name;
  };
  const dep = (d: DependencyView) => `${link(d.source)} → ${link(d.target)}`;
  const section = (title: string, items: string[], open = false): string[] => {
    if (items.length === 0) return [];
    const shown = items.slice(0, limit).map((item) => `- ${item}`);
    if (items.length > limit) shown.push(`- …and ${items.length - limit} more`);
    return [
      `<details${open ? " open" : ""}><summary><b>${title} (${items.length})</b></summary>`,
      "",
      ...shown,
      "",
      "</details>",
      "",
    ];
  };
  const lines = options.heading === false ? [] : ["### xray: architecture changes", ""];
  const counts = [
    view.modules.added.length || view.modules.removed.length
      ? `modules +${view.modules.added.length} −${view.modules.removed.length}`
      : "",
    view.dependencies.added.length || view.dependencies.removed.length
      ? `dependencies +${view.dependencies.added.length} −${view.dependencies.removed.length}`
      : "",
    view.symbols.added.length || view.symbols.removed.length
      ? `symbols +${view.symbols.added.length} −${view.symbols.removed.length}`
      : "",
  ].filter(Boolean);
  const nothing =
    counts.length === 0 &&
    view.cycles.introduced.length === 0 &&
    view.cycles.resolved.length === 0 &&
    view.api.changed.length === 0 &&
    view.routes.added.length === 0 &&
    view.routes.removed.length === 0;
  if (nothing) {
    lines.push(
      `No architecture changes from ${view.before.label}: the same modules, dependencies and API.`,
    );
    return `${lines.join("\n")}\n`;
  }
  const warnings = [
    view.cycles.introduced.length > 0
      ? `⚠️ **${view.cycles.introduced.length} new import cycle${view.cycles.introduced.length === 1 ? "" : "s"}**`
      : "",
    view.api.removed.length > 0
      ? `**${view.api.removed.length} exported symbol${view.api.removed.length === 1 ? "" : "s"} removed**`
      : "",
    view.cycles.resolved.length > 0
      ? `✅ ${view.cycles.resolved.length} import cycle${view.cycles.resolved.length === 1 ? "" : "s"} resolved`
      : "",
  ].filter(Boolean);
  lines.push(`Compared with ${view.before.label}: ${[...warnings, ...counts].join(" · ")}`, "");
  const cycle = (members: Summary[]) => [...members, members[0] as Summary].map(link).join(" → ");
  lines.push(
    ...section("New import cycles", view.cycles.introduced.map(cycle), true),
    ...section("New dependencies between directories", view.directories.added.map(dep), true),
    ...section("Removed exported API", view.api.removed.map(link), true),
    ...section(
      "Changed signatures",
      view.api.changed.map(
        (c) =>
          `${link(c.node)}: \`${c.before.replaceAll("`", "'")}\` → \`${c.after.replaceAll("`", "'")}\``,
      ),
      true,
    ),
    ...section("New routes", view.routes.added.map(link)),
    ...section("Removed routes", view.routes.removed.map(link)),
    ...section("Resolved import cycles", view.cycles.resolved.map(cycle)),
    ...section(
      "Coupling shifts (importers)",
      view.coupling.map((c) => `${link(c.node)}: ${c.before} → ${c.after}`),
    ),
    ...section("New dependencies between files", view.dependencies.added.map(dep)),
    ...section("Removed dependencies between files", view.dependencies.removed.map(dep)),
    ...section("Added files", view.modules.added.map(link)),
    ...section("Removed files", view.modules.removed.map(link)),
    ...section("Removed directory dependencies", view.directories.removed.map(dep)),
  );
  return `${lines.join("\n")}\n`;
}
