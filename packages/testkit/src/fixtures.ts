import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIDENCES, EDGE_KINDS, LANGUAGES, NODE_KINDS } from "@xray/schema";
import { z } from "zod";

export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export const ExpectedNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(NODE_KINDS),
});

export const ExpectedEdgeSchema = z.object({
  source: z.string().min(1),
  kind: z.enum(EDGE_KINDS),
  target: z.string().min(1),
  confidence: z.enum(CONFIDENCES).optional(),
  detail: z.string().optional(),
});

/**
 * The hand-written ground truth for a fixture repo. Only edges whose kind is listed in
 * `edgeKinds` are scored, so a fixture can focus on what it exercises.
 */
export const ExpectedGraphSchema = z.object({
  description: z.string().min(1),
  language: z.enum(LANGUAGES),
  edgeKinds: z.array(z.enum(EDGE_KINDS)).min(1),
  nodes: z.array(ExpectedNodeSchema),
  edges: z.array(ExpectedEdgeSchema),
  /** Import cycles as sorted lists of module IDs. */
  cycles: z.array(z.array(z.string()).min(2)).optional(),
});
export type ExpectedGraph = z.infer<typeof ExpectedGraphSchema>;
export type ExpectedEdge = z.infer<typeof ExpectedEdgeSchema>;

export type Fixture = {
  name: string;
  dir: string;
  expected: ExpectedGraph;
};

export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(FIXTURES_DIR, entry.name, "expected.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

export function loadFixture(name: string): Fixture {
  const dir = join(FIXTURES_DIR, name);
  const raw: unknown = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
  return { name, dir, expected: ExpectedGraphSchema.parse(raw) };
}
