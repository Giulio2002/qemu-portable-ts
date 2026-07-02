/**
 * Collects the dynamic libraries a platform package's binaries need, copies
 * the redistributable ones into the package (lib/ on Linux/macOS, bin/ on
 * Windows), rewrites lookup paths to be package-relative, and regenerates
 * licenses/THIRD-PARTY-NOTICES.txt.
 *
 * Usage: node --experimental-strip-types scripts/collect-runtime-deps.ts <package-dir>
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const packageDir = resolve(process.argv[2] ?? "");
if (!packageDir || !existsSync(join(packageDir, "package.json"))) {
  console.error("usage: collect-runtime-deps.ts <package-dir>");
  process.exit(2);
}

// System libraries that must NOT be bundled: they belong to the OS and are
// either non-redistributable or guaranteed present.
const LINUX_SYSTEM_PREFIXES = [
  "linux-vdso", "ld-linux", "libc.so", "libm.so", "libdl.so", "librt.so",
  "libpthread.so", "libresolv.so", "libgcc_s.so", "libstdc++.so",
];
const DARWIN_SYSTEM_PREFIXES = ["/usr/lib/", "/System/Library/"];
const WINDOWS_SYSTEM_DLLS = new Set([
  "kernel32.dll", "user32.dll", "advapi32.dll", "ws2_32.dll", "shell32.dll",
  "ole32.dll", "gdi32.dll", "winmm.dll", "iphlpapi.dll", "dnsapi.dll",
  "msvcrt.dll", "ntdll.dll", "crypt32.dll", "bcrypt.dll", "setupapi.dll",
  "cfgmgr32.dll", "shlwapi.dll", "version.dll", "userenv.dll", "psapi.dll",
]);

// License hints for the common QEMU runtime dependency set; anything not in
// this table is listed as UNKNOWN and must be resolved before release
// (verify-license-files.ts refuses UNKNOWN entries).
const LICENSE_HINTS: Record<string, string> = {
  glib: "LGPL-2.1-or-later",
  gobject: "LGPL-2.1-or-later",
  gio: "LGPL-2.1-or-later",
  gmodule: "LGPL-2.1-or-later",
  gthread: "LGPL-2.1-or-later",
  pixman: "MIT",
  slirp: "BSD-3-Clause",
  pcre: "BSD-3-Clause",
  intl: "LGPL-2.1-or-later",
  iconv: "LGPL-2.1-or-later",
  ffi: "MIT",
  zstd: "BSD-3-Clause",
  z: "Zlib",
  zlib: "Zlib",
  lzo: "GPL-2.0-or-later",
  snappy: "BSD-3-Clause",
  curl: "curl",
  ssh: "LGPL-2.1-or-later",
  nettle: "LGPL-3.0-or-later OR GPL-2.0-or-later",
  gnutls: "LGPL-2.1-or-later",
  sasl: "BSD-4-Clause-UC",
  png: "libpng-2.0",
  jpeg: "IJG",
  epoxy: "MIT",
  gettext: "LGPL-2.1-or-later",
  capstone: "BSD-3-Clause",
  crypto: "Apache-2.0",
  fdt: "GPL-2.0-or-later OR BSD-2-Clause",
  gmp: "LGPL-3.0-or-later OR GPL-2.0-or-later",
  hogweed: "LGPL-3.0-or-later OR GPL-2.0-or-later",
  idn2: "LGPL-3.0-or-later OR GPL-2.0-or-later",
  ncurses: "MIT-open-group",
  "p11-kit": "BSD-3-Clause",
  tasn1: "LGPL-2.1-or-later",
  unistring: "LGPL-3.0-or-later OR GPL-2.0-or-later",
  usb: "LGPL-2.1-or-later",
  vdeplug: "LGPL-2.1-or-later",
};

/** Copy a library, replacing any prior (possibly read-only) copy. */
function copyLib(from: string, to: string): void {
  rmSync(to, { force: true });
  copyFileSync(from, to);
  chmodSync(to, 0o755); // source may be 444; the copy must be editable
}

function licenseFor(libFile: string): string {
  const name = basename(libFile).toLowerCase();
  for (const [key, license] of Object.entries(LICENSE_HINTS)) {
    if (name.includes(key)) return license;
  }
  return "UNKNOWN — resolve before release";
}

function listBinaries(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("qemu-"))
    .map((f) => join(dir, f));
}

interface CollectedDep {
  file: string;
  from: string;
  license: string;
}

function collectLinux(): CollectedDep[] {
  const libDir = join(packageDir, "lib");
  mkdirSync(libDir, { recursive: true });
  const deps = new Map<string, CollectedDep>();

  for (const bin of listBinaries(join(packageDir, "bin"))) {
    const output = execFileSync("ldd", [bin], { encoding: "utf8" });
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(\S+)\s*=>\s*(\S+)/);
      if (!match) continue;
      const [, soname, path] = match;
      if (LINUX_SYSTEM_PREFIXES.some((p) => soname.startsWith(p))) continue;
      if (!existsSync(path)) continue;
      copyLib(path, join(libDir, soname));
      deps.set(soname, { file: soname, from: path, license: licenseFor(soname) });
    }
  }
  return [...deps.values()];
}

function collectDarwin(): CollectedDep[] {
  const libDir = join(packageDir, "lib");
  mkdirSync(libDir, { recursive: true });
  const deps = new Map<string, CollectedDep>();
  const queue = listBinaries(join(packageDir, "bin"));
  const isSystem = (p: string) =>
    DARWIN_SYSTEM_PREFIXES.some((prefix) => p.startsWith(prefix));

  while (queue.length > 0) {
    const target = queue.pop() as string;
    const output = execFileSync("otool", ["-L", target], { encoding: "utf8" });
    for (const line of output.split("\n").slice(1)) {
      const path = line.trim().split(" ")[0];
      if (!path || isSystem(path) || path.startsWith("@")) continue;
      const name = basename(path);
      const dest = join(libDir, name);
      if (!deps.has(name)) {
        copyLib(path, dest);
        deps.set(name, { file: name, from: path, license: licenseFor(name) });
        queue.push(dest); // transitively collect the dylib's own deps
      }
      // Point the referrer at the bundled copy.
      execFileSync("install_name_tool", [
        "-change",
        path,
        `@loader_path/../lib/${name}`,
        target,
      ]);
    }
  }
  for (const name of deps.keys()) {
    execFileSync("install_name_tool", [
      "-id",
      `@loader_path/${name}`,
      join(libDir, name),
    ]);
  }
  return [...deps.values()];
}

function collectWindows(): CollectedDep[] {
  // On Windows, DLLs live next to the executables in bin/. The MSYS2 build
  // environment has objdump; the mingw64 bin dir holds the DLLs.
  const binDir = join(packageDir, "bin");
  const deps = new Map<string, CollectedDep>();
  const searchDirs = (process.env.QEMU_DLL_SEARCH_PATH ?? "C:\\msys64\\mingw64\\bin")
    .split(";")
    .filter(Boolean);

  const queue = listBinaries(binDir);
  while (queue.length > 0) {
    const target = queue.pop() as string;
    const output = execFileSync("objdump", ["-p", target], { encoding: "utf8" });
    for (const line of output.split("\n")) {
      const match = line.match(/DLL Name:\s*(\S+)/);
      if (!match) continue;
      const dll = match[1];
      if (WINDOWS_SYSTEM_DLLS.has(dll.toLowerCase()) || dll.toLowerCase().startsWith("api-ms-")) continue;
      if (deps.has(dll) || existsSync(join(binDir, dll))) continue;
      for (const dir of searchDirs) {
        const candidate = join(dir, dll);
        if (existsSync(candidate)) {
          copyLib(candidate, join(binDir, dll));
          deps.set(dll, { file: dll, from: candidate, license: licenseFor(dll) });
          queue.push(join(binDir, dll));
          break;
        }
      }
    }
  }
  return [...deps.values()];
}

let deps: CollectedDep[];
switch (process.platform) {
  case "linux":
    deps = collectLinux();
    break;
  case "darwin":
    deps = collectDarwin();
    break;
  case "win32":
    deps = collectWindows();
    break;
  default:
    console.error(`Unsupported build platform: ${process.platform}`);
    process.exit(2);
}

// Regenerate THIRD-PARTY-NOTICES.txt from what was actually bundled.
const manifest = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8")
) as { name: string };
const notices = [
  "THIRD-PARTY NOTICES",
  "===================",
  "",
  `This package (${manifest.name}) redistributes QEMU (GPL-2.0-only; see`,
  "GPL-2.0.txt and QEMU-LICENSE.txt) together with the following dynamic",
  "libraries collected at build time:",
  "",
  ...(deps.length === 0
    ? ["  (none — binaries are statically linked apart from system libraries)"]
    : deps
        .sort((a, b) => a.file.localeCompare(b.file))
        .map((d) => `  ${d.file}\n    source: ${d.from}\n    license: ${d.license}`)),
  "",
  "Full license texts for these components are available in their upstream",
  "distributions and in the source archive published with each release.",
  "",
].join("\n");
writeFileSync(join(packageDir, "licenses", "THIRD-PARTY-NOTICES.txt"), notices);

console.log(`Collected ${deps.length} runtime dependencies into ${manifest.name}`);
for (const d of deps) console.log(`  ${d.file} (${d.license})`);
const unknown = deps.filter((d) => d.license.startsWith("UNKNOWN"));
if (unknown.length > 0) {
  console.warn(
    `WARNING: ${unknown.length} dependencies have unknown licenses; ` +
      `verify-license-files.ts will block release until resolved.`
  );
}
