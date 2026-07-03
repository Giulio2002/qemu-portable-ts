/**
 * Converts unpopulated platform package skeletons into installable
 * placeholder packages, so every name in the core package's
 * optionalDependencies exists in the registry (a missing optional dependency
 * 404-fails the whole `npm install`, it is not skipped).
 *
 * A placeholder:
 *  - keeps the real name/version/os/cpu/libc so npm's platform selection
 *    still works and a later release can replace it in-place;
 *  - ships NO binaries and NO GPL-licensed content (so it is MIT like the
 *    core package) and is marked `qemuPortable.placeholder = true`, which
 *    the runtime (checkHostSupport, resolver errors) reports to users;
 *  - is what CI publishes for a platform whose build is disabled or failed
 *    in a release that proceeds anyway.
 *
 * Usage:
 *   node --experimental-strip-types scripts/make-placeholder-package.ts --all
 *   node --experimental-strip-types scripts/make-placeholder-package.ts <package-dir>
 *
 * --all converts every packages/qemu-* directory that has no binaries in
 * bin/. Intended for the release workflow after artifact download; running
 * it locally rewrites skeleton manifests in your working tree.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function isPopulated(dir: string): boolean {
  const binDir = join(dir, "bin");
  return (
    existsSync(binDir) &&
    readdirSync(binDir).some((f) => f.startsWith("qemu-"))
  );
}

function makePlaceholder(dir: string): void {
  const manifestPath = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  > & { name: string; version: string };

  const placeholder = {
    name: manifest.name,
    version: manifest.version,
    description:
      `Placeholder for ${manifest.name} — no QEMU binaries have been ` +
      `published for this platform yet. It exists so npm installs of ` +
      `qemu-portable resolve on every platform.`,
    os: manifest.os,
    cpu: manifest.cpu,
    ...(manifest.libc ? { libc: manifest.libc } : {}),
    type: "module",
    files: ["README.md"],
    repository: manifest.repository,
    // No GPL content is present in a placeholder; the real binary package
    // that replaces it is GPL-2.0-only.
    license: "MIT",
    qemuPortable: { placeholder: true },
  };
  writeFileSync(manifestPath, JSON.stringify(placeholder, null, 2) + "\n");

  writeFileSync(
    join(dir, "README.md"),
    `# ${manifest.name} (placeholder)\n\n` +
      `This release does not include QEMU binaries for this platform. The\n` +
      `package exists so that \`qemu-portable\`'s optionalDependencies always\n` +
      `resolve; \`checkHostSupport()\` / \`qemu-portable preflight\` will report\n` +
      `this platform as unsupported until a release ships real binaries.\n\n` +
      `See https://github.com/Giulio2002/qemu-portable-ts for status.\n`
  );
  console.log(`placeholder: ${manifest.name} (${dir})`);
}

const targets =
  args[0] === "--all"
    ? readdirSync(join(repoRoot, "packages"))
        .filter((d) => d.startsWith("qemu-"))
        .map((d) => join(repoRoot, "packages", d))
    : args.map((a) => resolve(a));

if (targets.length === 0) {
  console.error("usage: make-placeholder-package.ts (--all | <package-dir>...)");
  process.exit(2);
}

let converted = 0;
for (const dir of targets) {
  if (!existsSync(join(dir, "package.json"))) continue;
  if (isPopulated(dir)) {
    if (args[0] !== "--all") console.log(`skipping ${dir}: contains binaries`);
    continue;
  }
  makePlaceholder(dir);
  converted += 1;
}
console.log(`make-placeholder-package: converted ${converted} package(s)`);
