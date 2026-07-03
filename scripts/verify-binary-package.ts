/**
 * Verifies a populated platform binary package before publishing:
 * binaries present and executable, data dir populated, compliance files
 * present, build-info.json coherent, no absolute build paths leaking.
 *
 * Usage: node --experimental-strip-types scripts/verify-binary-package.ts <package-dir>
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const packageDir = resolve(process.argv[2] ?? "");
const errors: string[] = [];
const fail = (msg: string) => errors.push(msg);

if (!packageDir || !existsSync(join(packageDir, "package.json"))) {
  console.error("usage: verify-binary-package.ts <package-dir>");
  process.exit(2);
}

const manifest = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8")
) as {
  name: string;
  version: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  license?: string;
  files?: string[];
};

// --- package.json metadata ----------------------------------------------------
if (!manifest.os?.length) fail(`${manifest.name}: package.json is missing "os"`);
if (!manifest.cpu?.length) fail(`${manifest.name}: package.json is missing "cpu"`);
// Linux packages must declare libc so npm installs the right flavor on
// Alpine vs glibc distros; the value must agree with the package name.
if (manifest.os?.[0] === "linux") {
  const expectedLibc = manifest.name.endsWith("-musl") ? "musl" : "glibc";
  if (!Array.isArray(manifest.libc) || manifest.libc[0] !== expectedLibc)
    fail(
      `${manifest.name}: package.json "libc" must be ["${expectedLibc}"] ` +
        `(got ${JSON.stringify(manifest.libc)})`
    );
}
if (manifest.license !== "GPL-2.0-only")
  fail(`${manifest.name}: license must be "GPL-2.0-only" (got ${manifest.license})`);
for (const required of ["bin", "share/qemu", "licenses", "build-info.json"]) {
  if (!manifest.files?.includes(required))
    fail(`${manifest.name}: package.json "files" must include "${required}"`);
}

const isWindows = manifest.os?.[0] === "win32";
const suffix = isWindows ? ".exe" : "";
const expectedBinaries = [
  `qemu-system-x86_64${suffix}`,
  `qemu-system-aarch64${suffix}`,
  `qemu-img${suffix}`,
];

// --- binaries -------------------------------------------------------------------
const binDir = join(packageDir, "bin");
for (const bin of expectedBinaries) {
  const path = join(binDir, bin);
  if (!existsSync(path)) {
    fail(`missing binary: bin/${bin}`);
    continue;
  }
  const stat = statSync(path);
  if (stat.size < 1024 * 100)
    fail(`bin/${bin} is suspiciously small (${stat.size} bytes)`);
  if (!isWindows && !(stat.mode & 0o111))
    fail(`bin/${bin} is not executable (mode ${stat.mode.toString(8)})`);
}

// --- self-containedness invariant -------------------------------------------------
// resolveRuntimeEnv() is documented as a *fallback*: the binaries must load
// their bundled libraries via RPATH ($ORIGIN/../lib) on Linux and
// @loader_path install names on macOS with no absolute references outside
// the OS (Homebrew/MacPorts/build-tree paths are release blockers). Only
// checkable on a matching host; the build jobs run this on the build host.
const hostMatchesPackage =
  (manifest.os?.[0] === "darwin" && process.platform === "darwin") ||
  (manifest.os?.[0] === "linux" && process.platform === "linux");

function tool(cmd: string, args: string[]): string | undefined {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  return res.status === 0 ? res.stdout : undefined;
}

if (hostMatchesPackage) {
  for (const bin of expectedBinaries) {
    const path = join(binDir, bin);
    if (!existsSync(path)) continue;

    if (process.platform === "darwin") {
      const out = tool("otool", ["-L", path]);
      if (out === undefined) {
        fail(`could not run otool on bin/${bin}`);
        continue;
      }
      for (const line of out.split("\n").slice(1)) {
        const dep = line.trim().split(" ")[0];
        if (!dep) continue;
        const selfContained =
          dep.startsWith("/usr/lib/") ||
          dep.startsWith("/System/") ||
          dep.startsWith("@loader_path/") ||
          dep.startsWith("@executable_path/");
        if (!selfContained)
          fail(
            `bin/${bin} links ${dep} — not self-contained ` +
              `(must be @loader_path/../lib or an OS library)`
          );
      }
    } else {
      const rpath =
        tool("patchelf", ["--print-rpath", path]) ??
        tool("readelf", ["-d", path]);
      if (rpath === undefined) {
        fail(`could not inspect RPATH of bin/${bin} (need patchelf or readelf)`);
      } else if (!rpath.includes("$ORIGIN/../lib")) {
        fail(`bin/${bin} RPATH lacks $ORIGIN/../lib — bundled libs will not resolve`);
      }
    }
  }
}

// --- QEMU data dir ---------------------------------------------------------------
const dataDir = join(packageDir, "share", "qemu");
const dataEntries = existsSync(dataDir)
  ? readdirSync(dataDir).filter((f) => f !== ".gitkeep")
  : [];
if (dataEntries.length === 0)
  fail("share/qemu is empty — firmware/keymap data was not installed");

// --- compliance files --------------------------------------------------------------
for (const file of [
  "licenses/GPL-2.0.txt",
  "licenses/QEMU-LICENSE.txt",
  "licenses/THIRD-PARTY-NOTICES.txt",
  "licenses/SOURCE-OFFER.txt",
  "build-info.json",
]) {
  if (!existsSync(join(packageDir, file))) fail(`missing compliance file: ${file}`);
}

// --- build-info.json ------------------------------------------------------------------
const buildInfoPath = join(packageDir, "build-info.json");
if (existsSync(buildInfoPath)) {
  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
    qemuVersion?: string;
    qemuGitRef?: string;
    targets?: string[];
    sourceArchiveSha256?: string;
  };
  if (!buildInfo.qemuVersion || buildInfo.qemuVersion === "unknown")
    fail("build-info.json: qemuVersion missing");
  // The binary must come from the single pinned source. Local dev fills
  // (scripts/vendor-local-qemu.ts) may bypass this with an explicit env var;
  // CI/release never sets it.
  const pinnedVersion = readFileSync(
    join(repoRoot, "third_party", "qemu", "QEMU_VERSION"),
    "utf8"
  ).trim();
  if (
    buildInfo.qemuVersion &&
    buildInfo.qemuVersion !== pinnedVersion &&
    process.env.QEMU_ALLOW_VERSION_DRIFT !== "1"
  )
    fail(
      `build-info.json: qemuVersion ${buildInfo.qemuVersion} does not match ` +
        `the pin ${pinnedVersion} (third_party/qemu/QEMU_VERSION). ` +
        `Set QEMU_ALLOW_VERSION_DRIFT=1 only for local dev fills.`
    );
  if (buildInfo.qemuGitRef?.includes("NOT FOR RELEASE") && process.env.QEMU_ALLOW_VERSION_DRIFT !== "1")
    fail("build-info.json: package was populated by vendor-local-qemu.ts and must not be released");
  if (!/^[0-9a-f]{64}$/.test(buildInfo.sourceArchiveSha256 ?? ""))
    fail("build-info.json: sourceArchiveSha256 must be a sha256 hex digest");
  for (const target of ["qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"]) {
    if (!buildInfo.targets?.includes(target))
      fail(`build-info.json: targets missing ${target}`);
  }
}

// --- absolute build-path leaks ---------------------------------------------------------
// The data dir must be located via -L at runtime; no file in the package may
// hard-reference the CI build tree.
const leakPatterns = ["/home/runner/", "/Users/runner/", "D:\\a\\", "C:\\a\\", "/__w/"];
function scanForLeaks(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      scanForLeaks(path);
    } else if (/\.(json|txt|conf|cfg)$/.test(entry)) {
      const content = readFileSync(path, "utf8");
      for (const pattern of leakPatterns) {
        if (content.includes(pattern))
          fail(`${path} leaks absolute build path (${pattern})`);
      }
    }
  }
}
scanForLeaks(packageDir);

if (errors.length > 0) {
  console.error(`verify-binary-package: ${manifest.name} FAILED`);
  for (const err of errors) console.error(`  ✖ ${err}`);
  process.exit(1);
}
console.log(`verify-binary-package: ${manifest.name}@${manifest.version} OK`);
