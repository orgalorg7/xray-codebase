import { compareStrings, DEPENDENCY_KINDS } from "@xray/analysis";
import { matchesAny } from "./glob.js";
import type { XrayService } from "./service.js";

/** A dependency rule: modules matching `from` must not depend on modules matching `disallow`. */
export type LayerRule = {
  name?: string;
  from: string[];
  disallow: string[];
  /** Exceptions within `disallow`. */
  allow?: string[];
};

/** The `check` section of `.xray.json`. */
export type CheckConfig = {
  /** Fail when there are more import cycles than this. */
  maxImportCycles?: number;
  /** Fail on any import cycle not recorded in the baseline. Default true when a baseline exists. */
  noNewCycles?: boolean;
  /** Type-only imports vanish at runtime; leave them out of cycle rules. Default false. */
  ignoreTypeOnlyCycles?: boolean;
  layers?: LayerRule[];
};

/** What `xray check --update-baseline` records: the accepted cycles. */
export type Baseline = { cycles: string[] };

export type Violation = {
  rule: "max-import-cycles" | "new-import-cycle" | "layer";
  message: string;
  /** For layer violations: where the dependency appears. */
  location?: { file: string; line: number };
};

export type CheckResult = { ok: boolean; violations: Violation[]; cycles: string[] };

const cycleKey = (members: readonly string[]): string => [...members].sort().join(" → ");

/** Evaluates CI rules. Pure: reading config and baseline files is the caller's job. */
export function runCheck(
  service: XrayService,
  config: CheckConfig,
  baseline?: Baseline,
): CheckResult {
  const violations: Violation[] = [];
  const cycles = service
    .cycles({ ignoreTypeOnly: config.ignoreTypeOnlyCycles ?? false })
    .imports.map((c) => cycleKey(c.members.map((m) => m.label)));

  if (config.maxImportCycles !== undefined && cycles.length > config.maxImportCycles) {
    violations.push({
      rule: "max-import-cycles",
      message: `${cycles.length} import cycles, more than the allowed ${config.maxImportCycles}`,
    });
  }
  if (baseline && config.noNewCycles !== false) {
    const known = new Set(baseline.cycles);
    for (const cycle of cycles) {
      if (!known.has(cycle))
        violations.push({ rule: "new-import-cycle", message: `new import cycle: ${cycle}` });
    }
  }

  const index = service.index();
  const pathOf = (id: string): string | undefined => {
    const mod = index.moduleOf(id);
    return mod ? index.node(mod)?.qualifiedName : undefined;
  };
  for (const rule of config.layers ?? []) {
    const seen = new Set<string>();
    for (const edge of index.edges) {
      if (!DEPENDENCY_KINDS.includes(edge.kind)) continue;
      // Requests over HTTP are not code depending on code.
      if (edge.detail === "http") continue;
      const from = pathOf(edge.source);
      const to = pathOf(edge.target);
      if (!from || !to || from === to) continue;
      if (!matchesAny(from, rule.from) || !matchesAny(to, rule.disallow)) continue;
      if (rule.allow && matchesAny(to, rule.allow)) continue;
      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const violation: Violation = {
        rule: "layer",
        message: `${rule.name ? `${rule.name}: ` : ""}${from} depends on ${to}`,
      };
      if (edge.location)
        violation.location = { file: edge.location.file, line: edge.location.line };
      violations.push(violation);
    }
  }
  violations.sort((a, b) => compareStrings(a.rule, b.rule) || compareStrings(a.message, b.message));
  return { ok: violations.length === 0, violations, cycles };
}
