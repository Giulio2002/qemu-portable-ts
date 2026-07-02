#!/usr/bin/env node
// Cross-version, cross-platform test runner.
//
// `node --test` glob patterns (Node 21+) and directory arguments (Node 21+)
// are not available on Node 20, and default discovery on newer Node also picks
// up the TypeScript sources in test/. Enumerating the compiled files and
// passing them as explicit path arguments is the one mode every supported Node
// (20/22/…) and every OS handles identically — no shell globbing involved.
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = join(__dirname, "build", "test");
let files;
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => join(dir, f));
} catch {
  console.error(`No compiled tests in ${dir}. Run "tsc -p tsconfig.test.json" first.`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No *.test.js files in ${dir}. Run "tsc -p tsconfig.test.json" first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
