/**
 * Verifies a populated platform binary package before publishing:
 * binaries present and executable, data dir populated, compliance files
 * present, build-info.json coherent, no absolute build paths leaking.
 *
 * Usage: node --experimental-strip-types scripts/verify-binary-package.ts <package-dir>
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

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
  libc?: string;
  license?: string;
  files?: string[];
};

// --- package.json metadata ----------------------------------------------------
if (!manifest.os?.length) fail(`${manifest.name}: package.json is missing "os"`);
if (!manifest.cpu?.length) fail(`${manifest.name}: package.json is missing "cpu"`);
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
const leakPatterns = ["/home/runner/", "/Users/runner/", "D:\\a\\", "/__w/"];
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
