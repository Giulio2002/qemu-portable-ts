/**
 * Smoke-tests the vendored QEMU binaries for the current host platform
 * through the real @org/qemu API (project.md §13.3): no multi-GB images,
 * just process startup, -machine help, and a qemu-img create/info/check
 * round-trip on a temporary image.
 *
 * Usage: node --experimental-strip-types scripts/smoke-test.ts
 * Requires the host's platform package to be populated (or installed).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Use the built core package directly from the workspace.
const require = createRequire(import.meta.url);
const qemu = require(resolve(import.meta.dirname, "..", "packages", "qemu", "dist", "index.js"));

async function main(): Promise<void> {
  const platform = qemu.getHostPlatform();
  console.log(`Host platform: ${platform}`);

  // 1. Resolution — must find vendored binaries, never PATH.
  const img = qemu.resolveQemuBinary("qemu-img");
  console.log(`qemu-img: ${img.path} (from ${img.packageName})`);
  assert.notEqual(img.packageName, "(system PATH)");

  // 2. Versions.
  const version = await qemu.getQemuVersion("qemu-img");
  console.log(`qemu-img version: ${version.qemuVersion}`);

  // 3. -machine help for each system emulator (minimal binary sanity).
  for (const command of ["qemu-system-x86_64", "qemu-system-aarch64"]) {
    const result = await qemu.execQemu(command, ["-machine", "help"], {
      timeoutMs: 60_000,
    });
    assert.equal(result.code, 0, `${command} -machine help exited ${result.code}`);
    const out = result.stdout?.toString("utf8") ?? "";
    assert.ok(out.includes("Supported machines"), `${command}: unexpected output`);
    console.log(`${command} -machine help: OK`);
  }

  // 4. qemu-img create / info / check round-trip on a temp image.
  const dir = mkdtempSync(join(tmpdir(), "qemu-smoke-"));
  try {
    const image = join(dir, "smoke.qcow2");
    await qemu.qemuImg.create({ path: image, size: "64M", format: "qcow2" });
    const info = await qemu.qemuImg.info(image);
    assert.equal(info.format, "qcow2");
    assert.equal(info.virtualSize, 64 * 1024 * 1024);
    const check = await qemu.qemuImg.check(image);
    assert.equal(check.code, 0, "qemu-img check reported problems");
    console.log("qemu-img create/info/check: OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED");
  console.error(err);
  process.exit(1);
});
