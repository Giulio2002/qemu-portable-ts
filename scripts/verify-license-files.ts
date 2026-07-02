/**
 * Release compliance gate (project.md §10): every platform package must ship
 * the full license set, a real (non-placeholder) third-party notices file,
 * and a source offer, before it may be published.
 *
 * Usage:
 *   node --experimental-strip-types scripts/verify-license-files.ts [package-dir...]
 *   (no args: verifies every packages/qemu-* directory that has a populated bin/)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

const packageDirs =
  args.length > 0
    ? args.map((a) => resolve(a))
    : readdirSync(join(repoRoot, "packages"))
        .filter((d) => d.startsWith("qemu-"))
        .map((d) => join(repoRoot, "packages", d));

let failed = false;

for (const dir of packageDirs) {
  const errors: string[] = [];
  const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name as string;

  const binDir = join(dir, "bin");
  const populated =
    existsSync(binDir) &&
    readdirSync(binDir).some((f) => f.startsWith("qemu-"));

  const licenses = join(dir, "licenses");

  const gpl = join(licenses, "GPL-2.0.txt");
  if (!existsSync(gpl)) {
    errors.push("missing licenses/GPL-2.0.txt");
  } else if (!readFileSync(gpl, "utf8").includes("GNU GENERAL PUBLIC LICENSE")) {
    errors.push("licenses/GPL-2.0.txt does not contain the GPL text");
  }

  if (!existsSync(join(licenses, "QEMU-LICENSE.txt")))
    errors.push("missing licenses/QEMU-LICENSE.txt");

  const offer = join(licenses, "SOURCE-OFFER.txt");
  if (!existsSync(offer)) {
    errors.push("missing licenses/SOURCE-OFFER.txt");
  } else {
    const text = readFileSync(offer, "utf8");
    if (!/https?:\/\//.test(text))
      errors.push("SOURCE-OFFER.txt must contain a source URL");
  }

  const notices = join(licenses, "THIRD-PARTY-NOTICES.txt");
  if (!existsSync(notices)) {
    errors.push("missing licenses/THIRD-PARTY-NOTICES.txt");
  } else if (populated) {
    // Once real binaries are in the package, the placeholder must have been
    // replaced by collect-runtime-deps.ts and contain no unknown licenses.
    const text = readFileSync(notices, "utf8");
    if (text.includes("populated at build time"))
      errors.push("THIRD-PARTY-NOTICES.txt is still the placeholder template");
    if (text.includes("UNKNOWN"))
      errors.push("THIRD-PARTY-NOTICES.txt contains dependencies with UNKNOWN licenses");
  }

  if (populated && !existsSync(join(dir, "build-info.json")))
    errors.push("missing build-info.json");

  if (errors.length > 0) {
    failed = true;
    console.error(`✖ ${name}${populated ? "" : " (unpopulated skeleton)"}`);
    for (const err of errors) console.error(`    ${err}`);
  } else {
    console.log(`✓ ${name}${populated ? "" : " (skeleton — license set complete)"}`);
  }
}

process.exit(failed ? 1 : 0);
