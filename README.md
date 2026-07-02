# @org/qemu — bundled QEMU for Node.js

A Node.js TypeScript library that ships QEMU through platform-specific npm
packages. Install one package, run QEMU — **no global QEMU installation
required**.

```bash
npm install @org/qemu
```

This is not a pure TypeScript QEMU implementation. It is a TypeScript control
layer over vendored native QEMU binaries:

```txt
Node.js app -> @org/qemu -> @org/qemu-<platform> -> vendored QEMU binary
```

The root package exposes the API and declares platform packages as
`optionalDependencies`; npm installs only the one that matches your OS, CPU
architecture, and (on Linux) libc.

> **Runtime target:** Node.js ≥ 20 only. QEMU is a native executable launched
> as a child process — there is no browser, Deno, Bun, edge-runtime, or
> Cloudflare Workers support.

## Supported platforms

| Host platform | Binary package |
|---|---|
| Linux x64 (glibc) | `@org/qemu-linux-x64` |
| Linux arm64 (glibc) | `@org/qemu-linux-arm64` |
| macOS arm64 | `@org/qemu-darwin-arm64` |
| macOS x64 | `@org/qemu-darwin-x64` |
| Windows x64 | `@org/qemu-win32-x64` |
| Windows arm64 | `@org/qemu-win32-arm64` |

Planned after MVP: `linux-x64-musl`, `linux-arm64-musl`, `freebsd-x64`.

**Guest targets** shipped in each platform package: `qemu-system-x86_64`,
`qemu-system-aarch64`, and `qemu-img`. More targets (`riscv64`, `arm`,
`i386`, `ppc64`) follow after MVP.

## Quick start

### Disk images with `qemu-img`

```ts
import { qemuImg } from "@org/qemu";

await qemuImg.create({ path: "./disk.qcow2", size: "20G", format: "qcow2" });

const info = await qemuImg.info("./disk.qcow2");
console.log(info.format, info.virtualSize);

await qemuImg.convert({ input: "./disk.qcow2", output: "./disk.raw", outputFormat: "raw" });
await qemuImg.resize({ path: "./disk.qcow2", size: "+5G" });
```

### Booting a VM

```ts
import { createVm, qemuImg } from "@org/qemu";

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

### Controlling a VM over QMP

```ts
import { QmpClient, createVm } from "@org/qemu";

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
import { execQemu, spawnQemu, qemuImg } from "@org/qemu";

await execQemu("qemu-system-x86_64", ["-machine", "help"]);
await qemuImg.raw(["snapshot", "-l", "disk.qcow2"]);
// or per-VM: createVm({ ..., extraArgs: ["-device", "..."] })
```

### CLI

```bash
npx qemu-ts diagnostics                          # platform/package/accelerator report
npx qemu-ts version                              # vendored QEMU version
npx qemu-ts which qemu-system-x86_64             # resolved binary path
npx qemu-ts run qemu-img -- info disk.qcow2      # raw args after --
npx qemu-ts run qemu-system-x86_64 -- -machine help
```

`run` prints the resolved vendored binary path, requires `--` before raw
QEMU args, never falls back to system QEMU, and exits with QEMU's exit code.

## How vendored binaries work

Each platform package contains `bin/` (QEMU executables), `lib/` (bundled
dynamic libraries with package-relative lookup paths), `share/qemu/`
(firmware, BIOS, and keymaps), `licenses/`, and `build-info.json` (exact QEMU
version, git ref, configure args, and source checksum).

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

The `@org/qemu` wrapper is MIT. The `@org/qemu-*` binary packages
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
   above), or your platform isn't supported yet. Run `npx qemu-ts diagnostics`.
2. **Slow VMs** — the accelerator fell back to TCG. Check
   `npx qemu-ts diagnostics` accelerator hints: on Linux you may need
   `kvm` group membership; on Windows the "Windows Hypervisor Platform"
   feature must be enabled.
3. **`Could not access KVM kernel module`** — harmless when using
   `acceleration: "auto"`; QEMU falls back to the next accelerator.
4. **Firmware not found** — don't pass your own `-L` unless you mean it; the
   library injects the vendored data dir automatically.
5. **Alpine/musl** — not yet supported (`linux-*-musl` packages are a
   post-MVP milestone).

## Repository layout

```
packages/qemu             core TypeScript package (@org/qemu)
packages/qemu-<platform>  binary packages (populated by CI builds)
scripts/                  QEMU build, dependency-collection, verify, smoke tests
third_party/qemu          pinned QEMU source version, checksums, patches
.github/workflows         ci / build-binaries / release pipelines
project.md                full project execution plan
```

## Development

```bash
npm install          # workspace install (core package only)
npm run build        # tsc build of @org/qemu
npm test             # unit tests (no QEMU binaries required)
npm run verify:licenses

# Build real binaries for your platform (needs QEMU build deps):
scripts/build-qemu-macos.sh packages/qemu-darwin-arm64
npm install --no-save ./packages/qemu-darwin-arm64
npm run smoke
```

## License

MIT for the wrapper (`@org/qemu` and this repository's tooling);
GPL-2.0-only for the binary packages. See [LICENSE](./LICENSE) and
[COMPLIANCE.md](./COMPLIANCE.md).
