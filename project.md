# Bundled QEMU TypeScript Library — Project Execution Plan

**Date:** 2026-07-02  
**Owner:** Product / Platform Engineering  
**Target package name used in examples:** `qemu-portable`  
**Project type:** Node.js TypeScript package wrapping vendored QEMU executables  
**Primary goal:** users can install one TypeScript package and run QEMU without having QEMU installed globally on the host.

---

## 1. Executive summary

We will build a Node.js TypeScript library that ships QEMU binaries through platform-specific npm packages. The root package, `qemu-portable`, exposes a TypeScript API and declares platform packages as `optionalDependencies`. At install time, npm installs only the package compatible with the user's host OS, CPU architecture, and Linux libc where applicable.

This is not a pure TypeScript QEMU implementation. It is a TypeScript control layer over vendored native QEMU binaries.

The implementation should follow this model:

```txt
qemu-portable
  TypeScript API
  runtime resolver
  process runner
  VM builder
  qemu-img helpers
  QMP client
  optionalDependencies -> platform binary packages

@qemu-portable/linux-x64
@qemu-portable/linux-arm64
@qemu-portable/linux-x64-musl
@qemu-portable/darwin-arm64
@qemu-portable/darwin-x64
@qemu-portable/win32-x64
  native QEMU executables
  QEMU firmware/data files
  required dynamic libraries
  license files
  source-offer/compliance metadata
  build-info.json
```

Do not bundle every host platform into the root package. That would produce a huge package, create bad install times, and force users to download binaries they cannot use.

---

## 2. Non-negotiable product decisions

### 2.1 Runtime target

This package is **Node.js-only**.

Do not promise browser support, edge-runtime support, Deno support, Bun support, or Cloudflare Workers support in the MVP. QEMU is a native executable and must be launched as a child process.

### 2.2 No global QEMU dependency

Default behavior must never require `qemu-system-*` or `qemu-img` to exist on `PATH`.

The resolver should use vendored binaries first. A system QEMU fallback may be offered later behind an explicit option:

```ts
resolveBinary("qemu-system-x86_64", { preferSystem: true })
```

But the default path is:

```txt
Node.js app -> qemu-portable -> @qemu-portable/<platform> -> vendored QEMU binary
```

### 2.3 Do not use install-time downloads in MVP

Avoid `postinstall` scripts that download QEMU from GitHub Releases or a CDN. They create security, proxy, offline-install, reproducibility, and enterprise-policy problems.

For MVP, the native binaries must be inside published platform npm packages.

### 2.4 Do not model all QEMU options in TypeScript

QEMU has a very large command-line surface. The API should provide:

1. a safe low-level process API,
2. typed helpers for common workflows,
3. a VM builder for common configurations,
4. an escape hatch for raw QEMU args.

The library must not block users from using advanced QEMU features.

### 2.5 Treat QEMU as security-sensitive

Do not market the package as a sandbox. Running QEMU still means running a large native process against potentially untrusted disk images, kernels, firmware, network inputs, and guest code.

---

## 3. Terminology

Use these terms consistently in code, docs, issues, and package names.

| Term | Meaning | Example |
|---|---|---|
| Host platform | The machine running Node.js and QEMU | `linux-x64`, `darwin-arm64`, `win32-x64` |
| Guest target | The architecture QEMU emulates or virtualizes | `x86_64`, `aarch64`, `riscv64` |
| Binary package | Platform-specific npm package containing native QEMU files | `@qemu-portable/linux-x64` |
| Core package | TypeScript wrapper package | `qemu-portable` |
| Accelerator | QEMU execution backend | `kvm`, `hvf`, `whpx`, `tcg` |
| TCG | QEMU software emulation fallback | works broadly, slower |
| QMP | QEMU Machine Protocol | JSON control socket |

Important distinction:

```txt
Host package:
  @qemu-portable/linux-x64

Guest binaries inside that host package:
  qemu-system-x86_64
  qemu-system-aarch64
  qemu-system-riscv64
  qemu-img
```

---

## 4. MVP scope

### 4.1 Supported host platforms for MVP

Ship these first:

```txt
linux-x64-glibc
linux-arm64-glibc
darwin-arm64
darwin-x64
win32-x64
win32-arm64
```

Add these after MVP:

```txt
linux-x64-musl
linux-arm64-musl
freebsd-x64
```

Reasoning:

- Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows x64 cover the practical desktop/server developer market.
- Alpine/musl support is valuable, but packaging QEMU and its dynamic dependencies for musl should be treated as a separate milestone.
- Windows arm64 can follow once we validate QEMU build maturity and package size.

### 4.2 Supported guest targets for MVP

Each host package should include only these initially:

```txt
qemu-system-x86_64
qemu-system-aarch64
qemu-img
```

Add later:

```txt
qemu-system-riscv64
qemu-system-arm
qemu-system-i386
qemu-system-ppc64
qemu-io
qemu-nbd
```

Do not ship every QEMU target in v0.1. It will make the package too large and create unnecessary maintenance work.

### 4.3 MVP API features

MVP must include:

- binary resolver,
- low-level spawn wrapper,
- version detection,
- `qemu-img create`, `info`, `convert`, `resize`, `check`,
- VM builder for basic Linux boot flows,
- QMP client over local Unix socket / named pipe where supported,
- platform diagnostics,
- clear missing-binary errors,
- compliance files in binary packages.

MVP does not need:

- GUI management,
- web UI,
- SPICE/VNC client implementation,
- libvirt integration,
- advanced snapshots/migration API,
- full QAPI type coverage,
- browser/WASM execution.

---

## 5. Repository layout

Use a monorepo.

```txt
repo/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  LICENSE
  README.md
  SECURITY.md
  COMPLIANCE.md

  packages/
    qemu/
      package.json
      src/
        index.ts
        resolve.ts
        platform.ts
        process.ts
        version.ts
        diagnostics.ts
        qemu-img.ts
        vm.ts
        args.ts
        qmp/
          client.ts
          protocol.ts
        errors.ts
      test/
        resolve.test.ts
        args.test.ts
        qemu-img.test.ts
        vm-builder.test.ts

    qemu-linux-x64/
      package.json
      bin/
        qemu-system-x86_64
        qemu-system-aarch64
        qemu-img
      lib/
        *.so*
      share/qemu/
        ...
      licenses/
        GPL-2.0.txt
        QEMU-LICENSE.txt
        THIRD-PARTY-NOTICES.txt
        SOURCE-OFFER.txt
      build-info.json

    qemu-linux-arm64/
      ...

    qemu-darwin-arm64/
      package.json
      bin/
        qemu-system-x86_64
        qemu-system-aarch64
        qemu-img
      lib/
        *.dylib
      share/qemu/
      licenses/
      build-info.json

    qemu-win32-x64/
      package.json
      bin/
        qemu-system-x86_64.exe
        qemu-system-aarch64.exe
        qemu-img.exe
        *.dll
      share/qemu/
      licenses/
      build-info.json

  scripts/
    build-qemu-linux.sh
    build-qemu-macos.sh
    build-qemu-windows.ps1
    collect-runtime-deps.ts
    verify-binary-package.ts
    verify-license-files.ts
    generate-build-info.ts
    smoke-test.ts

  third_party/
    qemu/
      source/                 # git submodule or extracted source tarball
      patches/
      checksums/
      README.md

  .github/workflows/
    ci.yml
    build-binaries.yml
    release.yml
```

Use `pnpm` or npm workspaces. The examples below use generic package names and do not require a specific workspace manager.

---

## 6. npm package structure

### 6.1 Core package: `qemu-portable`

`packages/qemu/package.json`:

```json
{
  "name": "qemu-portable",
  "version": "0.1.0",
  "description": "TypeScript API for vendored QEMU binaries",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE",
    "COMPLIANCE.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "optionalDependencies": {
    "@qemu-portable/linux-x64": "0.1.0",
    "@qemu-portable/linux-arm64": "0.1.0",
    "@qemu-portable/darwin-arm64": "0.1.0",
    "@qemu-portable/darwin-x64": "0.1.0",
    "@qemu-portable/win32-x64": "0.1.0"
  },
  "license": "MIT"
}
```

The wrapper can be MIT/Apache/ISC/etc. The shipped QEMU binary packages must carry QEMU's GPLv2 licensing/compliance files.

### 6.2 Linux glibc binary package

`packages/qemu-linux-x64/package.json`:

```json
{
  "name": "@qemu-portable/linux-x64",
  "version": "0.1.0",
  "description": "Vendored QEMU binaries for Linux x64 glibc",
  "os": ["linux"],
  "cpu": ["x64"],
  "libc": "glibc",
  "type": "module",
  "files": [
    "bin",
    "lib",
    "share/qemu",
    "licenses",
    "build-info.json"
  ],
  "license": "GPL-2.0-only"
}
```

For Alpine/musl packages later:

```json
{
  "name": "@qemu-portable/linux-x64-musl",
  "version": "0.2.0",
  "os": ["linux"],
  "cpu": ["x64"],
  "libc": "musl",
  "files": ["bin", "lib", "share/qemu", "licenses", "build-info.json"],
  "license": "GPL-2.0-only"
}
```

### 6.3 macOS binary package

`packages/qemu-darwin-arm64/package.json`:

```json
{
  "name": "@qemu-portable/darwin-arm64",
  "version": "0.1.0",
  "description": "Vendored QEMU binaries for macOS arm64",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "type": "module",
  "files": [
    "bin",
    "lib",
    "share/qemu",
    "licenses",
    "build-info.json"
  ],
  "license": "GPL-2.0-only"
}
```

### 6.4 Windows binary package

`packages/qemu-win32-x64/package.json`:

```json
{
  "name": "@qemu-portable/win32-x64",
  "version": "0.1.0",
  "description": "Vendored QEMU binaries for Windows x64",
  "os": ["win32"],
  "cpu": ["x64"],
  "type": "module",
  "files": [
    "bin",
    "share/qemu",
    "licenses",
    "build-info.json"
  ],
  "license": "GPL-2.0-only"
}
```

---

## 7. Public TypeScript API

The API has four layers:

1. **Resolver API** — find vendored binary paths.
2. **Process API** — run QEMU safely.
3. **Tool API** — typed helpers for `qemu-img`.
4. **VM API** — higher-level VM configuration and lifecycle.

### 7.1 Export surface

`packages/qemu/src/index.ts`:

```ts
export * from "./platform.js";
export * from "./resolve.js";
export * from "./process.js";
export * from "./version.js";
export * from "./diagnostics.js";
export * from "./qemu-img.js";
export * from "./vm.js";
export * from "./qmp/client.js";
export * from "./errors.js";
```

### 7.2 Core types

```ts
export type HostPlatform =
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "darwin-arm64"
  | "darwin-x64"
  | "win32-x64";

export type GuestTarget = "x86_64" | "aarch64" | "riscv64";

export type QemuSystemCommand =
  | "qemu-system-x86_64"
  | "qemu-system-aarch64"
  | "qemu-system-riscv64";

export type QemuToolCommand = "qemu-img";

export type QemuCommand = QemuSystemCommand | QemuToolCommand;

export type AccelerationMode = "auto" | "tcg" | "kvm" | "hvf" | "whpx";

export interface ResolvedQemuBinary {
  command: QemuCommand;
  path: string;
  packageName: string;
  packageRoot: string;
  hostPlatform: HostPlatform;
  qemuDataDir?: string;
  version?: string;
  buildInfo?: QemuBuildInfo;
}

export interface QemuBuildInfo {
  qemuVersion: string;
  qemuGitRef: string;
  buildHost: string;
  builtAt: string;
  targets: QemuCommand[];
  configureArgs: string[];
  runtimeDependencies: string[];
  sourceArchiveSha256?: string;
  patches?: string[];
}
```

### 7.3 Resolver API

```ts
export interface ResolveQemuOptions {
  command: QemuCommand;
  platform?: HostPlatform;
  preferSystem?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function getHostPlatform(): HostPlatform;

export function resolveQemuBinary(
  command: QemuCommand,
  options?: Omit<ResolveQemuOptions, "command">
): ResolvedQemuBinary;

export function listAvailableBinaries(): ResolvedQemuBinary[];
```

Behavior:

- Detect host with `process.platform` and `process.arch`.
- Detect Linux libc before selecting `glibc` or `musl` packages.
- Use `require.resolve()` or `import.meta.resolve()` equivalent to locate the installed platform package.
- Throw `QemuBinaryNotFoundError` if the package is missing.
- Include a specific message when optional dependencies were omitted.

Example error:

```txt
No vendored QEMU binary package found for linux-x64-glibc.

Expected optional dependency:
  @qemu-portable/linux-x64

This usually means optional dependencies were skipped, for example:
  npm install --omit=optional
  pnpm install --no-optional

Reinstall without omitting optional dependencies.
```

### 7.4 Process API

```ts
import type { ChildProcess, SpawnOptionsWithoutStdio } from "node:child_process";

export interface QemuRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit" | "ignore";
  signal?: AbortSignal;
  timeoutMs?: number;
  windowsHide?: boolean;
  extraEnv?: NodeJS.ProcessEnv;
}

export interface QemuProcess {
  child: ChildProcess;
  command: QemuCommand;
  binaryPath: string;
  args: string[];
  pid?: number;
  wait(): Promise<QemuExitResult>;
  kill(signal?: NodeJS.Signals): void;
}

export interface QemuExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout?: Buffer;
  stderr?: Buffer;
}

export function spawnQemu(
  command: QemuCommand,
  args: string[],
  options?: QemuRunOptions
): QemuProcess;

export function execQemu(
  command: QemuCommand,
  args: string[],
  options?: QemuRunOptions
): Promise<QemuExitResult>;
```

Rules:

- Use `spawn()` for long-running VMs.
- Use `execFile()` or `spawn()` for short-running commands like `qemu-img info`.
- Do not use shell execution.
- Do not concatenate args into one command string.
- Always pass args as `string[]`.
- Set `shell: false` explicitly.
- Set QEMU data directory through `-L <share/qemu>` for system emulators unless the user overrides it.

Implementation sketch:

```ts
import { spawn } from "node:child_process";
import { resolveQemuBinary } from "./resolve.js";

export function spawnQemu(command: QemuCommand, args: string[], options: QemuRunOptions = {}): QemuProcess {
  const resolved = resolveQemuBinary(command);

  const finalArgs = command.startsWith("qemu-system-") && resolved.qemuDataDir
    ? ["-L", resolved.qemuDataDir, ...args]
    : args;

  const child = spawn(resolved.path, finalArgs, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      ...options.extraEnv
    },
    stdio: options.stdio ?? "pipe",
    shell: false,
    signal: options.signal,
    windowsHide: options.windowsHide ?? true
  });

  return wrapChildProcess(child, command, resolved.path, finalArgs);
}
```

### 7.5 Version and diagnostics API

```ts
export interface QemuVersionInfo {
  command: QemuCommand;
  qemuVersion: string;
  rawOutput: string;
  binary: ResolvedQemuBinary;
}

export function getQemuVersion(command?: QemuCommand): Promise<QemuVersionInfo>;

export interface QemuDiagnostics {
  hostPlatform: HostPlatform;
  nodeVersion: string;
  installedBinaryPackages: string[];
  missingBinaryPackages: string[];
  binaries: ResolvedQemuBinary[];
  acceleratorHints: AcceleratorHint[];
}

export interface AcceleratorHint {
  accelerator: AccelerationMode;
  available: boolean;
  reason?: string;
}

export function getQemuDiagnostics(): Promise<QemuDiagnostics>;
```

Diagnostics should be user-facing and suitable for bug reports.

### 7.6 `qemu-img` helper API

```ts
export type DiskImageFormat = "qcow2" | "raw" | "vmdk" | "vdi" | "vpc";

export interface CreateImageOptions {
  path: string;
  size: string;
  format?: DiskImageFormat;
  backingFile?: string;
  backingFormat?: DiskImageFormat;
  preallocation?: "off" | "metadata" | "falloc" | "full";
}

export interface ConvertImageOptions {
  input: string;
  output: string;
  inputFormat?: DiskImageFormat;
  outputFormat: DiskImageFormat;
  compressed?: boolean;
}

export interface ResizeImageOptions {
  path: string;
  size: string;
  format?: DiskImageFormat;
  shrink?: boolean;
}

export interface ImageInfo {
  path: string;
  format?: string;
  virtualSize?: number;
  actualSize?: number;
  raw: unknown;
}

export const qemuImg: {
  raw(args: string[], options?: QemuRunOptions): Promise<QemuExitResult>;
  create(options: CreateImageOptions): Promise<void>;
  convert(options: ConvertImageOptions): Promise<void>;
  resize(options: ResizeImageOptions): Promise<void>;
  info(path: string, options?: { format?: DiskImageFormat }): Promise<ImageInfo>;
  check(path: string, options?: { format?: DiskImageFormat; repair?: "leaks" | "all" }): Promise<QemuExitResult>;
};
```

Example implementation for `create`:

```ts
export async function createImage(options: CreateImageOptions): Promise<void> {
  const args = ["create", "-f", options.format ?? "qcow2"];

  if (options.backingFile) {
    args.push("-b", options.backingFile);
    if (options.backingFormat) args.push("-F", options.backingFormat);
  }

  if (options.preallocation) {
    args.push("-o", `preallocation=${options.preallocation}`);
  }

  args.push(options.path, options.size);

  const result = await execQemu("qemu-img", args);
  if (result.code !== 0) {
    throw new QemuCommandError("qemu-img create failed", result);
  }
}
```

### 7.7 VM builder API

The VM API should produce auditable args, then start QEMU.

```ts
export interface VmConfig {
  target: GuestTarget;
  name?: string;
  machine?: string;
  cpu?: string;
  memory?: string | number;
  smp?: number;
  acceleration?: AccelerationMode;
  display?: "none" | "gtk" | "sdl" | "cocoa";
  serial?: "stdio" | "none" | { file: string };
  qmp?: QmpConfig;
  disks?: DiskConfig[];
  cdrom?: string;
  kernel?: KernelBootConfig;
  network?: NetworkConfig;
  extraArgs?: string[];
}

export interface DiskConfig {
  path: string;
  format?: DiskImageFormat;
  interface?: "virtio" | "ide" | "scsi";
  readonly?: boolean;
  snapshot?: boolean;
}

export interface KernelBootConfig {
  kernel: string;
  initrd?: string;
  append?: string;
}

export interface NetworkConfig {
  type: "none" | "user";
  hostForwards?: HostForward[];
}

export interface HostForward {
  protocol: "tcp" | "udp";
  hostPort: number;
  guestPort: number;
  hostAddress?: string;
  guestAddress?: string;
}

export interface QmpConfig {
  enabled: boolean;
  socketPath?: string;
  server?: boolean;
  wait?: boolean;
}

export interface BuiltVmCommand {
  command: QemuSystemCommand;
  args: string[];
  resolved: ResolvedQemuBinary;
}

export interface QemuVm {
  config: VmConfig;
  build(): BuiltVmCommand;
  start(options?: QemuRunOptions): QemuProcess;
}

export function createVm(config: VmConfig): QemuVm;
export function buildVmArgs(config: VmConfig): BuiltVmCommand;
```

Example usage:

```ts
import { createVm, qemuImg } from "qemu-portable";

await qemuImg.create({
  path: "./disk.qcow2",
  size: "20G",
  format: "qcow2"
});

const vm = createVm({
  target: "x86_64",
  name: "dev-vm",
  machine: "q35",
  cpu: "max",
  memory: "2G",
  smp: 2,
  acceleration: "auto",
  display: "none",
  serial: "stdio",
  disks: [
    { path: "./disk.qcow2", format: "qcow2", interface: "virtio" }
  ],
  network: {
    type: "user",
    hostForwards: [
      { protocol: "tcp", hostPort: 2222, guestPort: 22 }
    ]
  }
});

const proc = vm.start({ stdio: "inherit" });
await proc.wait();
```

### 7.8 Acceleration behavior

`acceleration: "auto"` should generate a platform-specific ordered fallback list.

```ts
function getAccelerationArgs(mode: AccelerationMode, target: GuestTarget): string[] {
  if (mode === "tcg") return ["-accel", "tcg"];

  if (mode === "kvm") return ["-accel", "kvm"];
  if (mode === "hvf") return ["-accel", "hvf"];
  if (mode === "whpx") return ["-accel", "whpx"];

  if (process.platform === "linux") return ["-accel", "kvm", "-accel", "tcg"];
  if (process.platform === "darwin") return ["-accel", "hvf", "-accel", "tcg"];
  if (process.platform === "win32") return ["-accel", "whpx", "-accel", "tcg"];

  return ["-accel", "tcg"];
}
```

QEMU supports specifying more than one `-accel`; the next accelerator is used if the previous one fails to initialize. Use that instead of trying to perfectly predict host capability.

### 7.9 QMP client API

Initial QMP support should be small and generic.

```ts
export interface QmpClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

export interface QmpCommand<TArgs extends object = object> {
  execute: string;
  arguments?: TArgs;
}

export interface QmpResponse<TResult = unknown> {
  return?: TResult;
  error?: {
    class: string;
    desc: string;
  };
}

export class QmpClient {
  constructor(options: QmpClientOptions);
  connect(): Promise<void>;
  execute<TResult = unknown, TArgs extends object = object>(
    command: string,
    args?: TArgs
  ): Promise<TResult>;
  close(): Promise<void>;
}
```

MVP helper methods:

```ts
await qmp.execute("query-status");
await qmp.execute("system_powerdown");
await qmp.execute("quit");
```

QMP must bind locally only. Do not expose QMP over public TCP in any helper.

---

## 8. Runtime binary resolution design

### 8.1 Platform mapping

```ts
const PLATFORM_PACKAGES: Record<string, string> = {
  "linux-x64-glibc": "@qemu-portable/linux-x64",
  "linux-arm64-glibc": "@qemu-portable/linux-arm64",
  "linux-x64-musl": "@qemu-portable/linux-x64-musl",
  "linux-arm64-musl": "@qemu-portable/linux-arm64-musl",
  "darwin-arm64": "@qemu-portable/darwin-arm64",
  "darwin-x64": "@qemu-portable/darwin-x64",
  "win32-x64": "@qemu-portable/win32-x64"
};
```

### 8.2 Binary path convention

Inside every platform package:

```txt
bin/qemu-img[.exe]
bin/qemu-system-x86_64[.exe]
bin/qemu-system-aarch64[.exe]
share/qemu/...
build-info.json
```

Resolver can then do:

```ts
const exe = process.platform === "win32" ? `${command}.exe` : command;
const binaryPath = require.resolve(`${pkg}/bin/${exe}`);
```

### 8.3 QEMU data directory

For system emulators, add:

```txt
-L <packageRoot>/share/qemu
```

QEMU's `-L` option sets the directory for BIOS, VGA BIOS, and keymaps. This prevents accidental dependency on host-installed QEMU data files.

### 8.4 Dynamic library resolution

Preferred approach by platform:

| Platform | Approach |
|---|---|
| Linux | Put required `.so` files in `lib/`; set RPATH to `$ORIGIN/../lib` with `patchelf` or launch with a controlled `LD_LIBRARY_PATH` fallback. |
| macOS | Put required `.dylib` files in `lib/`; use `install_name_tool` so binaries locate dylibs via `@loader_path/../lib`. |
| Windows | Put required `.dll` files next to `.exe` in `bin/`, or ensure the launch environment includes the package `bin/` path. |

Do not depend on Homebrew, MSYS2, apt, yum, pacman, or system package manager paths at runtime.

### 8.5 Resolver acceptance criteria

The resolver is done when:

- it resolves all supported commands on all supported platforms,
- it throws cleanly when optional dependencies are missing,
- it never shells out to `which qemu-system-*` by default,
- it can print all resolved files for diagnostics,
- it works from ESM and CommonJS consumers,
- it works when the package is nested inside another dependency,
- tests cover platform override without needing every platform package installed.

---

## 9. Binary build and packaging plan

### 9.1 Source strategy

Pin an upstream QEMU release or git tag.

Every binary package must include `build-info.json`:

```json
{
  "qemuVersion": "10.0.2",
  "qemuGitRef": "v10.0.2",
  "builtAt": "2026-07-02T00:00:00.000Z",
  "targets": [
    "qemu-system-x86_64",
    "qemu-system-aarch64",
    "qemu-img"
  ],
  "configureArgs": [
    "--target-list=x86_64-softmmu,aarch64-softmmu",
    "--disable-docs"
  ],
  "runtimeDependencies": [],
  "sourceArchiveSha256": "...",
  "patches": []
}
```

If we patch QEMU, store patches in:

```txt
third_party/qemu/patches/
```

The build must be reproducible enough that a developer can rebuild the binary package from source and compare versions/checksums where possible.

### 9.2 Configure targets

Initial target list:

```txt
x86_64-softmmu,aarch64-softmmu
```

Potential configure args:

```txt
--target-list=x86_64-softmmu,aarch64-softmmu
--disable-docs
--disable-werror
```

Be careful with aggressive `--disable-*` flags. Some features are needed indirectly by common guests, storage formats, firmware, networking, or platform accelerators.

### 9.3 Runtime dependency collection

After building each platform package, run a dependency collector:

Linux:

```bash
ldd bin/qemu-system-x86_64
ldd bin/qemu-system-aarch64
ldd bin/qemu-img
```

macOS:

```bash
otool -L bin/qemu-system-x86_64
otool -L bin/qemu-system-aarch64
otool -L bin/qemu-img
```

Windows:

```powershell
# Use dumpbin, llvm-objdump, or a dependency walker equivalent in CI.
```

Copy only redistributable runtime dependencies. Do not accidentally copy system libraries that should not be redistributed.

### 9.4 Firmware and data files

Each binary package must include the QEMU data directory:

```txt
share/qemu/
```

The API must point QEMU to this directory via `-L`.

Smoke tests must verify at least:

```bash
qemu-system-x86_64 -L ./share/qemu -machine help
qemu-system-aarch64 -L ./share/qemu -machine help
qemu-img --version
```

### 9.5 Release versioning

All packages should publish with the same npm version:

```txt
qemu-portable@0.1.0
@qemu-portable/linux-x64@0.1.0
@qemu-portable/linux-arm64@0.1.0
...
```

Expose the QEMU upstream version separately:

```ts
const version = await getQemuVersion();
console.log(version.qemuVersion);
```

Do not encode the QEMU version into the npm package name. Keep it in `build-info.json`, docs, changelog, and release notes.

---

## 10. Compliance requirements

This project distributes QEMU binaries. Treat compliance as a blocking release gate.

### 10.1 Binary packages must include

Every platform package must include:

```txt
licenses/GPL-2.0.txt
licenses/QEMU-LICENSE.txt
licenses/THIRD-PARTY-NOTICES.txt
licenses/SOURCE-OFFER.txt
build-info.json
```

### 10.2 Source availability

For every published QEMU binary package, we must provide corresponding source code and build scripts.

Acceptable implementation:

```txt
source/qemu-v<version>.tar.xz
source/patches/*.patch
source/build-scripts/*
source/checksums.txt
```

Options:

1. publish source archives as GitHub Release assets,
2. include a source link and written offer in `SOURCE-OFFER.txt`,
3. maintain a public `third_party/qemu` source branch/tag matching each npm release.

Legal must review the exact compliance wording before public release.

### 10.3 License split

The TypeScript wrapper may use a permissive license, but the binary packages should be marked as GPL-2.0-only unless legal approves another expression based on the actual included components.

Recommended package metadata:

```json
{
  "license": "GPL-2.0-only"
}
```

for binary packages, and:

```json
{
  "license": "MIT"
}
```

for the wrapper package, assuming wrapper code is original.

### 10.4 Compliance acceptance criteria

No binary package can be published unless:

- license files are present,
- corresponding source offer/source link is present,
- build info identifies QEMU version and patches,
- third-party notices are generated or manually reviewed,
- release notes include QEMU upstream version,
- legal signs off on package metadata and README wording.

---

## 11. Security design

### 11.1 Process execution rules

The process layer must:

- use `spawn()` or `execFile()`,
- pass arguments as arrays,
- set `shell: false`,
- never concatenate command strings,
- never expose unsanitized user input through shell mode,
- support `AbortSignal`,
- support timeout for short-running commands,
- expose stdout/stderr safely.

### 11.2 VM security defaults

Default VM builder behavior:

```txt
-display none
-serial stdio or none
-netdev user only when requested
-no-reboot optional for test flows
-accel auto -> host accelerator fallback to tcg
-L vendored share/qemu
```

Avoid by default:

```txt
-device usb-host
-netdev tap
-privileged helper tools
TCP QMP/HMP monitor
VNC/SPICE listening on public addresses
host filesystem passthrough
arbitrary host device passthrough
running as root
```

### 11.3 QMP/HMP monitor rule

QMP/HMP is a privileged control interface. Expose QMP only through local IPC:

- Unix domain socket on Linux/macOS,
- named pipe or local TCP bound to `127.0.0.1` on Windows if named pipe support is not implemented yet.

Do not expose QMP on `0.0.0.0`.

### 11.4 Untrusted inputs

Treat these as untrusted:

- guest disk images,
- ISO files,
- kernels,
- initrd files,
- firmware files,
- QMP clients,
- network traffic exposed to the guest,
- extra raw args supplied by callers.

Docs must warn users that this package does not turn QEMU into a security boundary in TCG/non-virtualization mode.

### 11.5 Supply-chain security

Release requirements:

- publish from CI only,
- use npm provenance/trusted publishing where possible,
- require 2FA on npm organization,
- pin QEMU source checksum,
- generate `build-info.json`,
- verify binary checksums in CI,
- smoke test packages after `npm pack`,
- do not allow arbitrary install scripts in consumer installs.

---

## 12. CLI design

Ship a small CLI for diagnostics and direct use.

Package binary entry in `qemu-portable`:

```json
{
  "bin": {
    "qemu-portable": "./dist/cli.js"
  }
}
```

Commands:

```bash
qemu-portable diagnostics
qemu-portable version
qemu-portable which qemu-system-x86_64
qemu-portable run qemu-img -- info disk.qcow2
qemu-portable run qemu-system-x86_64 -- -machine help
```

CLI rules:

- Require `--` before raw QEMU args.
- Print resolved vendored binary path.
- Never silently fall back to system QEMU.
- Return the same exit code as QEMU for `run` commands.

---

## 13. Testing plan

### 13.1 Unit tests

Test:

- platform detection,
- package-name mapping,
- binary path construction,
- missing optional dependency errors,
- arg builder output,
- qemu-img arg generation,
- QMP message framing,
- error classes.

Use platform overrides to avoid needing all binary packages in unit tests.

### 13.2 Integration tests

For each host platform package:

```bash
node -e "import('qemu-portable').then(async q => console.log(await q.getQemuVersion()))"
node -e "import('qemu-portable').then(q => console.log(q.resolveQemuBinary('qemu-img')))"
qemu-portable diagnostics
qemu-portable run qemu-img -- --version
qemu-portable run qemu-system-x86_64 -- -machine help
qemu-portable run qemu-system-aarch64 -- -machine help
```

### 13.3 Smoke VM test

Keep a tiny smoke test that does not require downloading a large OS image.

Options:

- boot a tiny known-good kernel/initrd artifact,
- use `-machine none` where possible for process startup tests,
- run `-machine help` for minimal binary sanity,
- run `qemu-img create/info/check` on temporary images.

Do not make normal CI depend on multi-GB OS images.

### 13.4 Package tests

For every package:

```bash
npm pack
mkdir /tmp/qemu-test
cd /tmp/qemu-test
npm init -y
npm install /path/to/org-qemu-0.1.0.tgz /path/to/platform-package.tgz
node -e "import('qemu-portable').then(q => console.log(q.getHostPlatform()))"
```

Acceptance criteria:

- packed package contains only expected files,
- no absolute build paths leak into runtime paths,
- binaries are executable on Unix,
- Windows `.exe` files run from package folder,
- dynamic libraries resolve without system package manager dependencies.

---

## 14. CI/CD plan

### 14.1 Workflows

```txt
ci.yml
  lint
  typecheck
  unit tests
  package metadata validation

build-binaries.yml
  build QEMU per platform
  collect runtime dependencies
  generate build-info.json
  smoke test binaries
  upload build artifacts

release.yml
  download build artifacts
  assemble npm packages
  run npm pack tests
  publish platform packages
  publish core package
  create GitHub Release with source archive and checksums
```

### 14.2 Build matrix

```yaml
strategy:
  matrix:
    include:
      - os: ubuntu-24.04
        package: qemu-linux-x64
        host: linux-x64-glibc
      - os: ubuntu-24.04-arm
        package: qemu-linux-arm64
        host: linux-arm64-glibc
      - os: macos-15
        package: qemu-darwin-arm64
        host: darwin-arm64
      - os: macos-13
        package: qemu-darwin-x64
        host: darwin-x64
      - os: windows-2025
        package: qemu-win32-x64
        host: win32-x64
```

Adjust runner names based on available CI provider support.

### 14.3 Publish order

Publish binary packages first:

```txt
@qemu-portable/linux-x64
@qemu-portable/linux-arm64
@qemu-portable/darwin-arm64
@qemu-portable/darwin-x64
@qemu-portable/win32-x64
```

Then publish core:

```txt
qemu-portable
```

Reason: the root package's `optionalDependencies` should already exist in the registry when users install it.

---

## 15. Error model

Define explicit error classes.

```ts
export class QemuError extends Error {
  readonly code: string;
}

export class UnsupportedPlatformError extends QemuError {
  readonly code = "ERR_QEMU_UNSUPPORTED_PLATFORM";
}

export class QemuBinaryNotFoundError extends QemuError {
  readonly code = "ERR_QEMU_BINARY_NOT_FOUND";
}

export class QemuCommandError extends QemuError {
  readonly code = "ERR_QEMU_COMMAND_FAILED";
  readonly result: QemuExitResult;
}

export class QemuTimeoutError extends QemuError {
  readonly code = "ERR_QEMU_TIMEOUT";
}

export class QmpProtocolError extends QemuError {
  readonly code = "ERR_QMP_PROTOCOL";
}
```

All errors must include actionable messages. No generic `ENOENT` leaking to end users without context.

---

## 16. Documentation requirements

`README.md` must include:

- install command,
- supported host platforms,
- supported guest targets,
- examples for `qemu-img`,
- example for booting a VM,
- explanation of vendored binaries,
- warning about optional dependencies,
- GPL/QEMU binary distribution note,
- security note,
- troubleshooting section.

`COMPLIANCE.md` must include:

- QEMU version,
- source availability instructions,
- list of included third-party files,
- license files location,
- build script reference.

`SECURITY.md` must include:

- supported versions,
- how to report vulnerabilities,
- QEMU update policy,
- warning that QEMU execution is not automatically a sandbox,
- safe QMP guidance.

---

## 17. Team work breakdown

### Track A — TypeScript API

Owner: Node/TypeScript engineer

Deliverables:

- package skeleton,
- resolver,
- process API,
- qemu-img helpers,
- VM builder,
- QMP client,
- tests,
- CLI.

Tickets:

```txt
QEMU-TS-001  Create monorepo and root package
QEMU-TS-002  Implement platform detection and resolver
QEMU-TS-003  Implement process runner with spawn/execFile
QEMU-TS-004  Implement qemu-img helpers
QEMU-TS-005  Implement VM arg builder
QEMU-TS-006  Implement QMP client
QEMU-TS-007  Implement diagnostics CLI
QEMU-TS-008  Add unit and integration tests
```

### Track B — Native binary builds

Owner: Systems/build engineer

Deliverables:

- QEMU source pin,
- build scripts per platform,
- dependency collection,
- runtime path fixing,
- smoke tests,
- binary package assembly.

Tickets:

```txt
QEMU-BIN-001  Pin QEMU source and checksum
QEMU-BIN-002  Build Linux x64 glibc package
QEMU-BIN-003  Build Linux arm64 glibc package
QEMU-BIN-004  Build macOS arm64 package
QEMU-BIN-005  Build macOS x64 package
QEMU-BIN-006  Build Windows x64 package
QEMU-BIN-007  Collect runtime dependencies
QEMU-BIN-008  Add package smoke tests
QEMU-BIN-009  Generate build-info.json
```

### Track C — Compliance and release

Owner: Release engineer + legal reviewer

Deliverables:

- license files,
- source offer,
- source artifacts,
- third-party notices,
- npm provenance publishing,
- release checklist.

Tickets:

```txt
QEMU-COMP-001  Draft binary package license layout
QEMU-COMP-002  Generate third-party notices
QEMU-COMP-003  Publish source archive with release
QEMU-COMP-004  Legal review of README and package metadata
QEMU-COMP-005  Add release compliance gate
QEMU-COMP-006  Configure npm trusted publishing/provenance
```

---

## 18. Milestones

### Milestone 0 — Decision and compliance pre-check

Exit criteria:

- package names chosen,
- QEMU version chosen,
- legal accepts distribution approach,
- MVP host/guest targets approved.

### Milestone 1 — TypeScript skeleton

Exit criteria:

- `qemu-portable` builds,
- resolver has mocked tests,
- process runner implemented,
- API types exported,
- CLI `diagnostics` stub works.

### Milestone 2 — One-platform proof

Exit criteria:

- Linux x64 package includes working QEMU binaries,
- core resolver launches vendored `qemu-img`,
- `qemu-img create/info` works,
- `qemu-system-x86_64 -machine help` works,
- no global QEMU is required.

### Milestone 3 — Full MVP platform matrix

Exit criteria:

- all MVP platform packages build,
- all packages pass smoke tests,
- dynamic deps resolve on clean machines,
- packages install through optional dependencies.

### Milestone 4 — VM API alpha

Exit criteria:

- `createVm()` builds valid args,
- `acceleration: "auto"` works by platform,
- `-L share/qemu` is injected,
- QMP local socket flow works,
- docs include runnable examples.

### Milestone 5 — Release candidate

Exit criteria:

- compliance files included,
- source artifacts available,
- npm provenance configured,
- security docs complete,
- package size reviewed,
- release checklist passes.

### Milestone 6 — Public alpha

Exit criteria:

- binary packages published,
- core package published,
- release notes include QEMU version and platform list,
- sample project verifies install and run.

---

## 19. Definition of done

The project is MVP-done when this works on every supported host platform:

```bash
npm install qemu-portable
```

```ts
import { getQemuVersion, qemuImg, createVm } from "qemu-portable";

console.log(await getQemuVersion("qemu-img"));

await qemuImg.create({
  path: "disk.qcow2",
  size: "1G",
  format: "qcow2"
});

const vm = createVm({
  target: "x86_64",
  machine: "q35",
  memory: "512M",
  acceleration: "auto",
  display: "none",
  disks: [{ path: "disk.qcow2", format: "qcow2", interface: "virtio" }],
  extraArgs: ["-machine", "help"]
});

const proc = vm.start({ stdio: "inherit" });
await proc.wait();
```

And:

- no global QEMU installation is required,
- vendored binary path is used,
- missing optional dependencies produce clear errors,
- license/source compliance files are present,
- `npm pack` tests pass,
- CI builds and smoke-tests every binary package,
- README documents limitations honestly.

---

## 20. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| GPL compliance missed | Release blocker / legal risk | Make compliance a CI gate and legal review requirement. |
| Package size too large | Bad install experience | Split platform packages, limit guest targets, strip symbols where allowed, avoid docs/debug files. |
| Runtime dynamic libs missing | Users get startup failures | Use clean-machine smoke tests and dependency collectors. |
| Hardware acceleration unavailable | Slow VMs | Use `-accel <host>, -accel tcg` fallback and clear diagnostics. |
| QEMU CVEs | Security exposure | Track QEMU releases, publish security updates quickly, document supported versions. |
| Windows packaging complexity | Broken Windows support | Treat Windows as first-class CI target, copy DLLs next to EXEs, run smoke tests on Windows. |
| macOS dylib path issues | Broken macOS support | Use `@loader_path` install names and clean-machine tests. |
| Optional deps omitted | Missing binary package | Throw actionable resolver error. |
| API overreach | Project stalls | Keep raw args escape hatch; type only common workflows. |
| Users assume sandbox | Security misunderstanding | Document limitations and safe defaults. |

---

## 21. Initial implementation checklist

```txt
[ ] Confirm package scope and names
[ ] Confirm wrapper license
[ ] Confirm QEMU upstream version
[ ] Confirm supported host platforms
[ ] Confirm supported guest targets
[ ] Create monorepo
[ ] Implement resolver
[ ] Implement process runner
[ ] Implement qemu-img helpers
[ ] Implement VM arg builder
[ ] Implement QMP client
[ ] Build Linux x64 QEMU package
[ ] Add build-info.json generation
[ ] Add license/compliance files
[ ] Add smoke tests
[ ] Add package tests
[ ] Add CI matrix
[ ] Add npm provenance/trusted publishing
[ ] Run legal review
[ ] Publish alpha
```

---

## 22. Engineering notes

### 22.1 Why optional dependencies

`optionalDependencies` let the root package list all platform packages without making unsupported platforms fail installation. Each platform package uses `os`, `cpu`, and Linux `libc` metadata so the package manager can select only compatible packages.

The resolver must still handle missing optional dependencies because users can intentionally omit them.

### 22.2 Why `-L share/qemu`

Without this, a vendored `qemu-system-*` binary may accidentally rely on QEMU data files installed elsewhere on the machine. That violates the product goal.

Always inject:

```txt
-L <resolved-package-root>/share/qemu
```

for system emulator commands unless explicitly disabled by an expert option.

### 22.3 Why raw args stay in the API

QEMU's surface area is too large to fully type in v0.1. The library should make common tasks easy but still allow advanced users to pass exact QEMU args.

### 22.4 Why no system fallback by default

If the library silently falls back to `/usr/bin/qemu-system-x86_64`, users cannot know whether they are running the vendored version or a random host version. That breaks reproducibility.

Use system fallback only through explicit user intent.

---

## 23. References for engineers

- npm `package.json` docs: optional dependencies, `os`, `cpu`, and `libc` fields: https://docs.npmjs.com/cli/v11/configuring-npm/package-json/
- Node.js `child_process` docs: `spawn()`, `execFile()`, and shell-mode warnings: https://nodejs.org/api/child_process.html
- QEMU license docs: https://www.qemu.org/docs/master/about/license.html
- GNU GPLv2 text: https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html
- QEMU security docs: https://www.qemu.org/docs/master/system/security.html
- QEMU system emulator introduction and accelerators: https://www.qemu.org/docs/master/system/introduction.html
- QEMU invocation docs for `-L` and `-accel`: https://www.qemu.org/docs/master/system/invocation.html
- QEMU `qemu-img` docs: https://www.qemu.org/docs/master/tools/qemu-img.html
- npm provenance docs: https://docs.npmjs.com/generating-provenance-statements/
