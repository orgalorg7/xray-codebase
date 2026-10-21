import { b } from "./b.js";

export function a(n: number): number {
  return n <= 0 ? 0 : b(n - 1);
}
