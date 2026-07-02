#!/usr/bin/env bun
import { runCli } from "./src/cli-entry.ts";

const result = await runCli({
  argv: process.argv.slice(2),
  io: {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
});
process.exit(result.exitCode);
