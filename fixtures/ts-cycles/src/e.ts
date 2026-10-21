import { type D, makeD } from "./d.js";

export type E = { d: D };

export function makeE(): E {
  return { d: makeD() };
}
