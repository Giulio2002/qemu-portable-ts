/**
 * DEV ONLY — populates the current host's platform package with the QEMU
 * already installed on this machine (e.g. from Homebrew), so the full stack
 * (resolver → -L injection → smoke tests) can be exercised locally without
 * a from-source build.
 *
 * Packages populated this way MUST NOT be published: their provenance does
 * not match build-info.json's source pin, and the compliance gate
 * (verify-license-files.ts) will reject their third-party notices. That is
 * intentional. Real packages come from scripts/build-qemu-*.
 *
 * Usage: node --experimental-strip-types scripts/vendor-local-qemu.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const BINARIES = ["qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"];

const platformPackage = (() => {
  if (process.platform === "darwin")
    return process.arch === "arm64" ? "qemu-darwin-arm64" : "qemu-darwin-x64";
  if (process.platform === "linux")
    return process.arch === "arm64" ? "qemu-linux-arm64" : "qemu-linux-x64";
  console.error(`vendor-local-qemu only supports macOS/Linux hosts (got ${process.platform})`);
  process.exit(2);
})();
const packageDir = join(repoRoot, "packages", platformPackage);

function findOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) return realpathSync(candidate);
  }
  console.error(`${name} not found on PATH — install QEMU locally first (e.g. brew install qemu).`);
  process.exit(2);
}

// --- copy binaries -------------------------------------------------------------
const binDir = join(packageDir, "bin");
rmSync(binDir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });
let shareSource = "";
for (const name of BINARIES) {
  const source = findOnPath(name);
  copyFileSync(source, join(binDir, name));
  chmodSync(join(binDir, name), 0o755);
  // Derive the installation's data dir from the first system binary,
  // e.g. /opt/homebrew/Cellar/qemu/<v>/bin -> ../share/qemu.
  if (!shareSource) {
    const candidate = join(dirname(dirname(source)), "share", "qemu");
    if (existsSync(candidate)) shareSource = candidate;
  }
  console.log(`vendored ${source}`);
}

// --- copy QEMU data dir ----------------------------------------------------------
if (!shareSource) {
  console.error("Could not locate the installation's share/qemu data directory.");
  process.exit(2);
}
const shareDest = join(packageDir, "share", "qemu");
rmSync(shareDest, { recursive: true, force: true });
cpSync(shareSource, shareDest, { recursive: true, dereference: true });
console.log(`vendored data dir ${shareSource}`);
const prune = spawnSync(
  process.execPath,
  ["--experimental-strip-types", join(repoRoot, "scripts", "prune-firmware.ts"), packageDir],
  { stdio: "inherit" }
);
if (prune.status !== 0) process.exit(prune.status ?? 1);

// --- bundle dynamic libraries -------------------------------------------------------
const collect = spawnSync(
  process.execPath,
  ["--experimental-strip-types", join(repoRoot, "scripts", "collect-runtime-deps.ts"), packageDir],
  { stdio: "inherit" }
);
if (collect.status !== 0) process.exit(collect.status ?? 1);

// --- re-sign (macOS: install_name_tool invalidates signatures) ----------------------
if (process.platform === "darwin") {
  const entitlements = join(repoRoot, "scripts", "qemu-hvf.entitlements");
  for (const name of BINARIES) {
    execFileSync("codesign", [
      "--force", "--sign", "-",
      ...(name.startsWith("qemu-system-") ? ["--entitlements", entitlements] : []),
      join(binDir, name),
    ]);
  }
  const libDir = join(packageDir, "lib");
  if (existsSync(libDir)) {
    for (const lib of execFileSync("ls", [libDir], { encoding: "utf8" }).split("\n")) {
      if (lib.endsWith(".dylib"))
        execFileSync("codesign", ["--force", "--sign", "-", join(libDir, lib)]);
    }
  }
}

// --- build-info (marked as local, non-release provenance) ----------------------------
const versionOutput = execFileSync(join(binDir, "qemu-img"), ["--version"], {
  encoding: "utf8",
});
const qemuVersion = versionOutput.match(/version\s+([0-9][^\s(]*)/)?.[1] ?? "unknown";
const info = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    join(repoRoot, "scripts", "generate-build-info.ts"),
    packageDir,
    "--qemu-version", qemuVersion,
    "--git-ref", "local-system-vendor (NOT FOR RELEASE)",
    "--source-sha256", "0".repeat(64),
    "--configure-args", "local-system-vendor",
    "--patches", "",
  ],
  { stdio: "inherit" }
);
if (info.status !== 0) process.exit(info.status ?? 1);

// --- link into node_modules so the resolver can find it -------------------------------
// A plain symlink instead of `npm install ./packages/...`: npm's arborist
// cannot reconcile a file: install with the same name as an unresolvable
// optionalDependency of a workspace package.
const npmName = platformPackage.replace(/^qemu-/, "qemu-portable-");
const linkPath = join(repoRoot, "node_modules", npmName);
mkdirSync(dirname(linkPath), { recursive: true });
rmSync(linkPath, { recursive: true, force: true });
symlinkSync(packageDir, linkPath, "dir");
console.log(`linked node_modules/${npmName} -> packages/${platformPackage}`);

console.log(`\nPopulated packages/${platformPackage} from the local QEMU ${qemuVersion}.`);
console.log("Next: npm run smoke");
