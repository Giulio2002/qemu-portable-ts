/**
 * Links a workspace platform package into node_modules so the resolver can
 * find it, without `npm install ./packages/<dir>`: npm's arborist cannot
 * reconcile a file: install whose name matches an unresolvable
 * optionalDependency of a workspace package (it fails with
 * "npm error Invalid Version:"). A plain symlink sidesteps arborist
 * entirely. Used by CI smoke steps and local development.
 *
 * Usage: node --experimental-strip-types scripts/link-platform-package.ts <package-dir>
 *   e.g. node --experimental-strip-types scripts/link-platform-package.ts packages/qemu-darwin-arm64
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const packageDir = resolve(process.argv[2] ?? "");
if (!packageDir) {
  console.error("usage: link-platform-package.ts <package-dir>");
  process.exit(2);
}

const name = (
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name: string;
  }
).name;

const linkPath = join(repoRoot, "node_modules", ...name.split("/"));
mkdirSync(dirname(linkPath), { recursive: true });
rmSync(linkPath, { recursive: true, force: true });
// junction: works on Windows without admin rights; treated as "dir" elsewhere.
symlinkSync(packageDir, linkPath, "junction");
console.log(`linked node_modules/${name} -> ${packageDir}`);
