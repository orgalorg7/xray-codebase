import { styleText } from "node:util";
import type { NodeKind } from "@xray/schema";
import type { Summary } from "@xray/service";

/** Where a command writes. Tests pass buffers; the binary passes the process streams. */
export type IO = {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Use colors (a TTY that did not opt out with NO_COLOR). */
  color: boolean;
};

type Style = Parameters<typeof styleText>[0];

export function painter(io: IO) {
  const paint = (style: Style, text: string): string =>
    io.color ? styleText(style, text, { validateStream: false }) : text;
  return {
    bold: (t: string) => paint("bold", t),
    dim: (t: string) => paint("dim", t),
    red: (t: string) => paint("red", t),
    green: (t: string) => paint("green", t),
    yellow: (t: string) => paint("yellow", t),
    blue: (t: string) => paint("blue", t),
    cyan: (t: string) => paint("cyan", t),
    magenta: (t: string) => paint("magenta", t),
  };
}

const KIND_TAG: Partial<Record<NodeKind, string>> = {
  module: "file",
  class: "class",
  interface: "iface",
  "type-alias": "type",
  function: "fn",
  method: "method",
  variable: "var",
  property: "prop",
  route: "route",
  "cli-command": "cmd",
  component: "comp",
  test: "test",
  directory: "dir",
  package: "pkg",
  external: "ext",
};

/** One line describing a node: `fn  login  src/auth.ts:12`. */
export function line(io: IO, node: Summary, extra = ""): string {
  const p = painter(io);
  const tag = (KIND_TAG[node.kind] ?? node.kind).padEnd(6);
  const where =
    node.file && node.kind !== "module"
      ? p.dim(`  ${node.file}${node.line ? `:${node.line}` : ""}`)
      : "";
  return `${p.dim(tag)} ${p.bold(node.label)}${where}${extra ? `  ${extra}` : ""}`;
}
