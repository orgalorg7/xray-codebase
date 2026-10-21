#!/usr/bin/env node
import { main } from "./cli.js";

const color = process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  color,
});
process.exitCode = code;
