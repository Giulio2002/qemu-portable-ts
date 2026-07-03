/**
 * Boot smoke test: proves the vendored qemu-system binaries can actually run
 * a guest under TCG, not just print -machine help. Two self-contained guest
 * payloads are generated in-process (no downloads, no multi-GB images):
 *
 *  - x86_64: a 512-byte MBR boot sector that writes "BOOT-OK" to COM1
 *    (0x3F8) and halts. Exercises SeaBIOS + 16550 UART + disk boot.
 *  - aarch64: a flat Linux-Image-header kernel for -machine virt that
 *    writes "BOOT-OK" to the PL011 UART (0x0900_0000) and parks in wfi.
 *    Exercises the virt machine + PL011 without needing EDK2.
 *
 * Each guest must emit BOOT-OK on the serial console within the timeout.
 *
 * Usage: node --experimental-strip-types scripts/boot-test.ts
 * Requires the host's platform package to be populated (like smoke-test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const qemu = require(resolve(import.meta.dirname, "..", "packages", "qemu", "dist", "index.js"));

const MARKER = "BOOT-OK";
const TIMEOUT_MS = 120_000; // TCG on a loaded CI runner can be slow to start

/** 512-byte MBR boot sector: print BOOT-OK to COM1, halt. */
function buildX86BootSector(): Buffer {
  const sector = Buffer.alloc(512);
  const code = Buffer.from([
    0x31, 0xc0, // xor ax, ax
    0x8e, 0xd8, // mov ds, ax
    0xbe, 0x15, 0x7c, // mov si, 0x7c15 (msg)
    // loop:
    0xac, // lodsb
    0x84, 0xc0, // test al, al
    0x74, 0x06, // jz halt
    0xba, 0xf8, 0x03, // mov dx, 0x3f8 (COM1)
    0xee, // out dx, al
    0xeb, 0xf5, // jmp loop
    // halt:
    0xf4, // hlt
    0xeb, 0xfd, // jmp halt
  ]);
  code.copy(sector, 0);
  sector.write(`${MARKER}\r\n\0`, code.length, "ascii");
  sector[510] = 0x55;
  sector[511] = 0xaa;
  return sector;
}

/**
 * Flat AArch64 kernel with a Linux Image header (so -kernel loads it at a
 * deterministic address): print BOOT-OK to the PL011 at 0x0900_0000, wfi.
 */
function buildAarch64Kernel(): Buffer {
  const instructions = [
    0xd2a12001, // movz x1, #0x900, lsl #16  ; x1 = 0x09000000 (PL011 UARTDR)
    0x100000e2, // adr  x2, #28              ; msg (8 instructions after i0)
    // loop:
    0x38401443, // ldrb w3, [x2], #1
    0x34000063, // cbz  w3, halt (+12)
    0x39000023, // strb w3, [x1]
    0x17fffffd, // b    loop (-12)
    // halt:
    0xd503207f, // wfi
    0x17ffffff, // b    halt (-4)
  ];
  const body = Buffer.alloc(instructions.length * 4 + MARKER.length + 2);
  instructions.forEach((insn, i) => body.writeUInt32LE(insn >>> 0, i * 4));
  body.write(`${MARKER}\n\0`, instructions.length * 4, "ascii");

  // 64-byte AArch64 Linux Image header (Documentation/arm64/booting.rst).
  const header = Buffer.alloc(64);
  header.writeUInt32LE(0x14000010, 0); // code0: b #64 (skip header)
  header.writeBigUInt64LE(0n, 8); // text_offset
  header.writeBigUInt64LE(BigInt(64 + body.length), 16); // image_size
  header.writeUInt32LE(0x644d5241, 56); // magic "ARM\x64"
  return Buffer.concat([header, body]);
}

interface BootCase {
  command: string;
  args: (payloadPath: string) => string[];
}

const CASES: Record<string, BootCase> = {
  "qemu-system-x86_64": {
    command: "qemu-system-x86_64",
    args: (p) => [
      "-accel", "tcg",
      "-display", "none",
      "-serial", "stdio",
      "-monitor", "none",
      "-no-reboot",
      "-drive", `file=${p},format=raw,if=ide`,
    ],
  },
  "qemu-system-aarch64": {
    command: "qemu-system-aarch64",
    args: (p) => [
      "-machine", "virt",
      "-cpu", "cortex-a57",
      "-accel", "tcg",
      "-display", "none",
      "-serial", "stdio",
      "-monitor", "none",
      "-no-reboot",
      "-kernel", p,
    ],
  },
};

async function bootToMarker(command: string, args: string[]): Promise<void> {
  const proc = qemu.spawnQemu(command, args, { stdio: "pipe" });
  let output = "";

  const sawMarker = new Promise<void>((resolveMarker, rejectMarker) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(MARKER)) resolveMarker();
    };
    proc.child.stdout?.on("data", onData);
    proc.child.stderr?.on("data", onData);
    proc.child.once("close", () => {
      rejectMarker(
        new Error(`${command} exited before printing ${MARKER}.\nOutput:\n${output}`)
      );
    });
    proc.child.once("error", rejectMarker);
  });

  const timeout = new Promise<void>((_, rejectTimeout) => {
    const t = setTimeout(() => {
      rejectTimeout(
        new Error(`${command} did not print ${MARKER} within ${TIMEOUT_MS} ms.\nOutput:\n${output}`)
      );
    }, TIMEOUT_MS);
    t.unref();
  });

  try {
    await Promise.race([sawMarker, timeout]);
    console.log(`${command}: guest booted to serial "${MARKER}" (tcg)`);
  } finally {
    proc.kill("SIGKILL");
    await proc.wait().catch(() => {});
  }
}

async function main(): Promise<void> {
  const platform = qemu.getHostPlatform();
  console.log(`Boot test on ${platform}`);

  const dir = mkdtempSync(join(tmpdir(), "qemu-boot-"));
  try {
    const x86Image = join(dir, "boot-x86.img");
    writeFileSync(x86Image, buildX86BootSector());
    await bootToMarker("qemu-system-x86_64", CASES["qemu-system-x86_64"].args(x86Image));

    const a64Kernel = join(dir, "boot-aarch64.bin");
    writeFileSync(a64Kernel, buildAarch64Kernel());
    await bootToMarker("qemu-system-aarch64", CASES["qemu-system-aarch64"].args(a64Kernel));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("BOOT TEST PASSED");
}

main().catch((err) => {
  console.error("BOOT TEST FAILED");
  console.error(err);
  process.exit(1);
});
