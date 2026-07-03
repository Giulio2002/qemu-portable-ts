# qemu-portable — bundled QEMU for Node.js

A Node.js TypeScript library that ships QEMU through platform-specific npm
packages. Install one package, run QEMU — **no global QEMU installation
required**.

```bash
npm install qemu-portable
```

This is not a pure TypeScript QEMU implementation. It is a TypeScript control
layer over vendored native QEMU binaries:

```txt
Node.js app -> qemu-portable -> @qemu-portable/<platform> -> vendored QEMU binary
```

The root package exposes the API and declares platform packages as
`optionalDependencies`; npm installs only the one that matches your OS, CPU
architecture, and (on Linux) libc.

> **Runtime target:** Node.js ≥ 20 only. QEMU is a native executable launched
> as a child process — there is no browser, Deno, Bun, edge-runtime, or
> Cloudflare Workers support.

## Supported platforms

| Host platform | Binary package | Host accelerator |
|---|---|---|
| Linux x64 (glibc) | `@qemu-portable/linux-x64` | kvm |
| Linux arm64 (glibc) | `@qemu-portable/linux-arm64` | kvm |
| Linux x64 (musl/Alpine) | `@qemu-portable/linux-x64-musl` | kvm |
| Linux arm64 (musl/Alpine) | `@qemu-portable/linux-arm64-musl` | kvm |
| macOS arm64 | `@qemu-portable/darwin-arm64` | hvf |
| macOS x64 | `@qemu-portable/darwin-x64` | hvf |
| Windows x64 | `@qemu-portable/win32-x64` | whpx |
| Windows arm64 | `@qemu-portable/win32-arm64` | tcg only (no WHPX upstream) |

All eight are built from the same pinned QEMU source in CI, and every build
must boot a real guest to a serial `BOOT-OK` (TCG) before it can be
published. Platforms without published binaries ship a registry
*placeholder* package so installs never 404 — `checkHostSupport()` reports
them as unsupported. Planned: `freebsd-x64`.

**Guest targets** shipped in each platform package: `qemu-system-x86_64`,
`qemu-system-aarch64`, and `qemu-img`. More targets (`riscv64`, `arm`,
`i386`, `ppc64`) follow after MVP.

## Quick start

### Disk images with `qemu-img`

```ts
import { qemuImg } from "qemu-portable";

await qemuImg.create({ path: "./disk.qcow2", size: "20G", format: "qcow2" });

const info = await qemuImg.info("./disk.qcow2");
console.log(info.format, info.virtualSize);

await qemuImg.convert({ input: "./disk.qcow2", output: "./disk.raw", outputFormat: "raw" });
await qemuImg.resize({ path: "./disk.qcow2", size: "+5G" });
```

### Booting a VM

```ts
import { createVm, qemuImg } from "qemu-portable";

await qemuImg.create({ path: "./disk.qcow2", size: "20G", format: "qcow2" });

const vm = createVm({
  target: "x86_64",
  name: "dev-vm",
  machine: "q35",
  cpu: "max",
  memory: "2G",
  smp: 2,
  acceleration: "auto",     // kvm/hvf/whpx with automatic tcg fallback
  display: "none",
  serial: "stdio",
  disks: [{ path: "./disk.qcow2", format: "qcow2", interface: "virtio" }],
  network: {
    type: "user",
    hostForwards: [{ protocol: "tcp", hostPort: 2222, guestPort: 22 }],
  },
});

console.log(vm.build().args);        // audit the exact QEMU argv first
const proc = vm.start({ stdio: "inherit" });
await proc.wait();
```

### Running commands inside the guest (`vm.exec`)

Enable the QEMU Guest Agent and run commands in the guest, capturing output —
like `docker exec`, but for a full VM:

```ts
import { createVm } from "qemu-portable";

const vm = createVm({
  target: "x86_64",
  memory: "2G",
  acceleration: "auto",
  disks: [{ path: "./ubuntu-cloud.qcow2", format: "qcow2", interface: "virtio" }],
  guestAgent: true,          // wires the guest-agent virtio-serial channel
});
vm.start();

// A string runs through a shell, so &&, pipes, and redirection work:
const { exitCode, stdout } = await vm.exec("ls -la / && cd /etc && cat os-release");
console.log(exitCode, stdout);

// An argv array runs a binary directly, no shell:
await vm.exec(["/usr/bin/systemctl", "status", "nginx"]);
```

**Requirement:** the guest OS must have `qemu-guest-agent` installed and
running (and, on some distros, `guest-exec` enabled in its config). Cloud
images ship it or install it via cloud-init. A blank disk has no agent to talk
to. Without a guest agent, use SSH instead (see the `hostForwards` example
above) — `vm.exec` reports a clear `GuestAgentError` if the agent never
answers.

### Controlling a VM over QMP

```ts
import { QmpClient, createVm } from "qemu-portable";

const vm = createVm({
  target: "x86_64",
  memory: "1G",
  qmp: { enabled: true, socketPath: "/tmp/vm-qmp.sock" },
  // ...
});
const proc = vm.start();

const qmp = new QmpClient({ socketPath: "/tmp/vm-qmp.sock" });
await qmp.connect();
console.log(await qmp.execute("query-status"));
await qmp.execute("system_powerdown");
await qmp.close();
```

### Raw escape hatch

QEMU's command-line surface is enormous; the typed API covers common
workflows and never blocks the rest:

```ts
import { execQemu, spawnQemu, qemuImg } from "qemu-portable";

await execQemu("qemu-system-x86_64", ["-machine", "help"]);
await qemuImg.raw(["snapshot", "-l", "disk.qcow2"]);
// or per-VM: createVm({ ..., extraArgs: ["-device", "..."] })
```

### CLI

```bash
npx qemu-portable diagnostics                          # platform/package/accelerator report
npx qemu-portable features                             # build feature flags as JSON
npx qemu-portable preflight                            # host-support check (exit 0 = usable)
npx qemu-portable version                              # vendored QEMU version
npx qemu-portable which qemu-system-x86_64             # resolved binary path
npx qemu-portable run qemu-img -- info disk.qcow2      # raw args after --
npx qemu-portable run qemu-system-x86_64 -- -machine help
```

`run` prints the resolved vendored binary path, requires `--` before raw
QEMU args, never falls back to system QEMU, and exits with QEMU's exit code.

### Feature detection

Ask what the vendored build supports before launching anything:

```ts
import { checkHostSupport, getQemuFeatures, getAcceleratorHints } from "qemu-portable";

// Non-throwing preflight — every failure mode is data, never an exception:
const support = checkHostSupport();
if (!support.ok) console.error(support.reason);

// Compiled-in capabilities, recorded at build time in build-info.json:
const features = getQemuFeatures();
features.guestTargets;          // ["x86_64", "aarch64"]
features.accelerators;          // ["tcg", "hvf"] — compiled in, not necessarily usable
features.networking.slirp;      // true

// Host availability (is /dev/kvm accessible, etc.) is a separate question:
getAcceleratorHints();
```

`listAvailableBinaries()` is also non-throwing and lists every binary the
installed platform package actually ships.

### Spawning QEMU yourself

If you own your process lifecycle, you don't have to use `spawnQemu()`/
`createVm()` — resolution gives you everything you need as data:

```ts
import { resolveQemuBinary, resolveRuntimeEnv } from "qemu-portable";
import { spawn } from "node:child_process";

const bin = resolveQemuBinary("qemu-system-x86_64");
bin.path;         // absolute path to the vendored executable
bin.firmwareDir;  // pass as -L so firmware/keymaps come from the package

// Env additions (as data) for the bundled dynamic libraries. The binaries
// are built self-contained (RPATH $ORIGIN/../lib on Linux, @loader_path
// install names on macOS, DLLs beside the .exe on Windows) and CI enforces
// that as a release invariant — so these are a genuine fallback, but apply
// them for safety:
const env = { ...process.env };
for (const { name, value } of resolveRuntimeEnv(bin)) {
  env[name] = env[name] ? `${value}:${env[name]}` : value;
}

spawn(bin.path, ["-L", bin.firmwareDir!, "-machine", "q35", /* ... */], { env });
```

## How vendored binaries work

Each platform package contains `bin/` (QEMU executables), `lib/` (bundled
dynamic libraries with package-relative lookup paths), `share/qemu/`
(firmware, BIOS, and keymaps), `licenses/`, and `build-info.json` (exact QEMU
version, git ref, configure args, feature flags, and source checksum).

`share/qemu` is pruned to what the shipped guest targets can use (SeaBIOS,
EDK2 for x86_64/aarch64, option ROMs, keymaps, dtbs) — firmware for
architectures the package has no emulator for is dropped at build time
(`scripts/prune-firmware.ts`), roughly halving the installed size.

The resolver locates the installed platform package through normal
`node_modules` resolution and the process layer always injects
`-L <package>/share/qemu` for system emulators, so nothing depends on a
host QEMU installation — not even its data files. A system QEMU on PATH is
used **only** when you explicitly pass `preferSystem: true`.

## Optional dependencies warning

If you install with `npm install --omit=optional` or
`pnpm install --no-optional`, no binary package is installed and every API
call throws `QemuBinaryNotFoundError` with reinstall instructions. Docker
images and CI configs sometimes set these flags globally — check there first.

## Licensing of the binaries (GPL)

The `qemu-portable` wrapper is MIT. The `@qemu-portable/*` binary packages
redistribute QEMU and are licensed **GPL-2.0-only**; each one ships the full
GPL text, QEMU license notes, third-party notices for bundled libraries, and
a written source offer. Complete corresponding source (tarball, patches,
build scripts) is attached to every GitHub Release. See
[COMPLIANCE.md](./COMPLIANCE.md).

## Security

Running QEMU means running a large native process against potentially
untrusted disk images, kernels, firmware, and guest code. **This package is
not a sandbox**, especially in TCG (software emulation) mode. Defaults are
conservative — headless display, no NIC unless requested, QMP over local IPC
only — but the security boundary is yours to design.

- [SECURITY.md](./SECURITY.md) — reporting policy, supported versions, QEMU
  update policy.
- [docs/security.md](./docs/security.md) — **threat model, trust boundaries,
  what the library validates vs. passes through, and a hardening checklist**
  for handling untrusted input.

## Troubleshooting

1. **`QemuBinaryNotFoundError`** — optional dependencies were omitted (see
   above), or your platform isn't supported yet. Run `npx qemu-portable diagnostics`.
2. **Slow VMs** — the accelerator fell back to TCG. Check
   `npx qemu-portable diagnostics` accelerator hints: on Linux you may need
   `kvm` group membership; on Windows the "Windows Hypervisor Platform"
   feature must be enabled.
3. **`Could not access KVM kernel module`** — harmless when using
   `acceleration: "auto"`; QEMU falls back to the next accelerator.
4. **Firmware not found** — don't pass your own `-L` unless you mean it; the
   library injects the vendored data dir automatically.
5. **Alpine/musl** — supported via `@qemu-portable/linux-{x64,arm64}-musl`;
   npm selects the right flavor automatically from the `libc` field. If you
   see the glibc package on Alpine, your npm is too old to understand `libc`
   (needs npm ≥ 9).

## License

MIT for the wrapper (`qemu-portable` and this repository's tooling);
GPL-2.0-only for the binary packages. See [LICENSE](./LICENSE) and
[COMPLIANCE.md](./COMPLIANCE.md).
