/**
 * Prunes share/qemu in a platform package down to what the shipped guest
 * targets (x86_64, aarch64) can actually use. QEMU's `make install` ships
 * firmware for every architecture it knows about (~316 MB); the foreign-arch
 * blobs (ppc, sparc, riscv, loongarch, s390, hppa, alpha, arm32 UEFI code)
 * are dead weight in an npm package that only ships
 * qemu-system-{x86_64,aarch64}.
 *
 * Also removes the firmware/ descriptor directory: its JSON files embed
 * absolute build-host paths, which are wrong for a relocatable package (the
 * data dir is injected via -L at runtime) and trip the build-path-leak gate.
 *
 * Kept: SeaBIOS/qboot, VGA and network option ROMs, edk2 for x86_64 +
 * aarch64 (edk2-arm-vars.fd is the NVRAM template the aarch64 descriptor
 * pairs with edk2-aarch64-code.fd), keymaps, dtbs, edk2-licenses.txt, and
 * any small file this list does not name — unknown small files are cheap,
 * deleting them is not.
 *
 * Usage: node --experimental-strip-types scripts/prune-firmware.ts <package-dir>
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const packageDir = resolve(process.argv[2] ?? "");
const dataDir = join(packageDir, "share", "qemu");
if (!packageDir || !existsSync(dataDir)) {
  console.error("usage: prune-firmware.ts <package-dir>  (share/qemu must exist)");
  process.exit(2);
}

/** Foreign-architecture / unused firmware, by exact name or prefix. */
const PRUNE_PATTERNS: RegExp[] = [
  // arm32 UEFI code (qemu-system-aarch64 only needs aarch64-code + arm-vars)
  /^edk2-arm-code\.fd$/,
  // architectures we do not ship system emulators for
  /^edk2-riscv-/,
  /^edk2-loongarch64-/,
  /^opensbi-riscv/,
  /^openbios-/, // sparc, ppc
  /^slof\.bin$/, // ppc
  /^skiboot\.lid$/, // ppc powernv
  /^pnv-pnor\.bin$/, // ppc powernv
  /^vof(-nvram)?\.bin$/, // ppc
  /^qemu_vga\.ndrv$/, // ppc mac
  /^u-boot(\.|-)/, // ppc
  /^bamboo\.dtb$/, // ppc (dtb subdir handled by name below)
  /^canyonlands\.dtb$/, // ppc
  /^hppa-firmware/, // hppa
  /^palcode-clipper$/, // alpha
  /^s390-(ccw|netboot)\.img$/, // s390x
  /^QEMU,(tcx|cgthree)\.bin$/, // sparc display
  // non-runtime artifacts
  /^trace-events-all$/,
  /^qemu-nsis\.bmp$/,
  // descriptor dir: embeds absolute build-host paths; useless when the data
  // dir is relocated and injected with -L
  /^firmware$/,
];

let freed = 0;
let removed = 0;
for (const entry of readdirSync(dataDir)) {
  if (!PRUNE_PATTERNS.some((p) => p.test(entry))) continue;
  const path = join(dataDir, entry);
  const stat = statSync(path);
  const size = stat.isDirectory()
    ? readdirSync(path).reduce((n, f) => n + statSync(join(path, f)).size, 0)
    : stat.size;
  rmSync(path, { recursive: true, force: true });
  freed += size;
  removed += 1;
  console.log(`pruned ${entry} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// Sanity: the firmware the shipped targets rely on must still be present.
const REQUIRED = [
  "bios-256k.bin",
  "vgabios-stdvga.bin",
  "efi-virtio.rom",
  "edk2-x86_64-code.fd",
  "edk2-aarch64-code.fd",
  "edk2-arm-vars.fd",
  "edk2-licenses.txt",
  "keymaps",
];
const missing = REQUIRED.filter((f) => !existsSync(join(dataDir, f)));
if (missing.length > 0) {
  console.error(`prune-firmware: required firmware missing after prune: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(
  `prune-firmware: removed ${removed} entries, freed ${(freed / 1024 / 1024).toFixed(0)} MB`
);
