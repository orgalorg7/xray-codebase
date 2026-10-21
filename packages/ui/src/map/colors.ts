import type { NodeKind } from "@xray/schema";

export type Theme = "light" | "dark";

/** Symbol colors by kind, tuned to stay distinct on both themes. */
const KIND_COLORS: Record<Theme, Partial<Record<NodeKind, string>>> = {
  light: {
    function: "#2f6fdb",
    method: "#1a9a8c",
    class: "#8250df",
    interface: "#a371f7",
    "type-alias": "#8c8fa3",
    enum: "#b08800",
    variable: "#c46a00",
    property: "#bc8a4a",
    route: "#e5484d",
    "cli-command": "#f76b15",
    component: "#d6409f",
    test: "#30a46c",
    external: "#6e7781",
  },
  dark: {
    function: "#6ea8ff",
    method: "#3dd6c3",
    class: "#b392f0",
    interface: "#c9a8ff",
    "type-alias": "#a5a8bd",
    enum: "#e3b341",
    variable: "#f0a35e",
    property: "#d9b380",
    route: "#ff6b70",
    "cli-command": "#ff9147",
    component: "#f47ec1",
    test: "#4cc38a",
    external: "#8b949e",
  },
};

export const kindColor = (kind: NodeKind, theme: Theme): string =>
  KIND_COLORS[theme][kind] ?? (theme === "dark" ? "#c9d1d9" : "#57606a");

/** A hue per district, spread around the color wheel by the golden angle. */
export function districtHue(district: number | undefined): number {
  return district === undefined ? 220 : (district * 137.508 + 200) % 360;
}

/** Fill for a container circle (directory, module, class): a soft district tint by depth. */
export function containerFill(
  theme: Theme,
  district: number | undefined,
  depth: number,
  isModule: boolean,
): string {
  const hue = districtHue(district);
  if (theme === "dark") {
    const light = isModule ? 17 + Math.min(depth, 6) * 1.5 : 11 + Math.min(depth, 6) * 2;
    return `hsl(${hue} ${isModule ? 28 : 14}% ${light}%)`;
  }
  const light = isModule ? 93 - Math.min(depth, 6) * 1.2 : 97 - Math.min(depth, 6) * 1.6;
  return `hsl(${hue} ${isModule ? 45 : 22}% ${light}%)`;
}

export const containerStroke = (theme: Theme, district: number | undefined): string =>
  theme === "dark"
    ? `hsl(${districtHue(district)} 25% 32%)`
    : `hsl(${districtHue(district)} 30% 74%)`;

/** Ring colors for blast radius: hot near the change, cooling outward. */
export function ringColor(depth: number, maxDepth: number): string {
  const t = maxDepth <= 1 ? 0 : (depth - 1) / (maxDepth - 1);
  const hue = 4 + t * 46; // red → amber
  return `hsl(${hue} 90% ${52 + t * 6}%)`;
}

/** Churn heat: commits mapped to a cold → hot scale. */
export function heatColor(value: number, max: number, theme: Theme): string {
  const t = max <= 0 ? 0 : Math.min(1, Math.log1p(value) / Math.log1p(max));
  const hue = 210 - t * 210;
  return theme === "dark" ? `hsl(${hue} 70% ${28 + t * 18}%)` : `hsl(${hue} 85% ${88 - t * 30}%)`;
}
