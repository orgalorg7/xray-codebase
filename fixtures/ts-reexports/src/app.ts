import { add, times } from "./index.js";

export function main(): number {
  return times(add(1, 2), 3);
}
