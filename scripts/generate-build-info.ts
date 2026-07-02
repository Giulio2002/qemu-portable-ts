/**
 * Writes build-info.json into a platform package.
 *
 * Usage:
 *   node --experimental-strip-types scripts/generate-build-info.ts <package-dir> \
 *     --qemu-version 10.0.2 --git-ref v10.0.2 --source-sha256 <hex> \
 *     --configure-args "--target-list=...;--disable-docs" --patches "a.patch;b.patch"
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

const [packageDirArg, ...rest] = process.argv.slice(2);
const packageDir = resolve(packageDirArg ?? "");
if (!packageDir || !existsSync(join(packageDir, "package.json"))) {
  console.error("usage: generate-build-info.ts <package-dir> [options]");
  process.exit(2);
}

function flag(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index !== -1 ? rest[index + 1] : undefined;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "").split(";").map((s) => s.trim()).filter(Boolean);
}

const binDir = join(packageDir, "bin");
const targets = existsSync(binDir)
  ? readdirSync(binDir)
      .filter((f) => f.startsWith("qemu-"))
      .filter((f) => !f.endsWith(".dll"))
      .map((f) => f.replace(/\.exe$/, ""))
      .sort()
  : [];

const libDir = join(packageDir, "lib");
const runtimeDependencies = [
  ...(existsSync(libDir)
    ? readdirSync(libDir).filter((f) => !f.startsWith("."))
    : []),
  ...(existsSync(binDir)
    ? readdirSync(binDir).filter((f) => f.endsWith(".dll"))
    : []),
].sort();

const buildInfo = {
  qemuVersion: flag("qemu-version") ?? "unknown",
  qemuGitRef: flag("git-ref") ?? "unknown",
  buildHost: process.env.GITHUB_RUN_ID
    ? `github-actions:${process.env.RUNNER_OS ?? "unknown"}:${process.env.GITHUB_RUN_ID}`
    : hostname(),
  builtAt: new Date().toISOString(),
  targets,
  configureArgs: splitList(flag("configure-args")),
  runtimeDependencies,
  sourceArchiveSha256: flag("source-sha256"),
  patches: splitList(flag("patches")),
};

writeFileSync(
  join(packageDir, "build-info.json"),
  JSON.stringify(buildInfo, null, 2) + "\n"
);
console.log(`Wrote ${join(packageDir, "build-info.json")}`);
console.log(JSON.stringify(buildInfo, null, 2));
