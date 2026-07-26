# Security hardening guide

This document is the engineering companion to [`SECURITY.md`](../SECURITY.md).
`SECURITY.md` is the policy (how to report, what is supported); this guide is
the **threat model, trust boundaries, and hardening checklist** for people
building on `qemu-portable`.

The single most important sentence: **`qemu-portable` is not a sandbox.** It
launches a large native process (QEMU) against inputs you may not control. It
adds safe defaults and input validation around QEMU; it does not add an
isolation boundary that QEMU itself doesn't provide.

---

## 1. Threat model

### What this library defends against

- **Shell / argument injection through the library's own API.** Processes are
  spawned with `shell: false` and argv arrays — never a command string. The
  VM builder validates and escapes every value it interpolates into a QEMU
  option string, so a hostile value in a *typed config field* cannot inject
  extra QEMU options.
- **Path traversal / arbitrary binary execution via the command name.** The
  resolver does not restrict *which* QEMU commands you may run — that's your
  call — but it requires a command to name a binary *inside* the platform
  package's `bin/` directory (a bare file name, no path separators, no `..`,
  not absolute). So `"../../bin/sh"` is refused, while `qemu-io`, `qemu-nbd`,
  or any other binary the package actually ships resolves normally.
- **Accidental use of a host QEMU.** The resolver never falls back to a
  system QEMU on `PATH` unless you explicitly pass `preferSystem: true`.
- **A malicious or desynchronized QMP peer.** The QMP framer bounds how much
  it will buffer, and responses are correlated by command id (not arrival
  order) so a dropped/late reply cannot mis-deliver one command's result to
  another caller.
- **Disk passphrases leaking through the process table.** A LUKS passphrase is
  never placed in argv, where any local user can read it with `ps`. It reaches
  QEMU only as a `secret` object backed by a file. An inline `{ passphrase }`
  is written to a `0600` file inside a `0700` temp directory and deleted when
  the VM process exits.

### What this library does **not** defend against

- **Malicious guest code, disk images, ISOs, kernels, initrds, or firmware.**
  These reach QEMU's parsers and device emulation, which have their own CVE
  history. In TCG (software emulation) mode there is no hardware isolation.
- **Whatever you put in `extraArgs` / the raw escape hatches.** `extraArgs`,
  `spawnQemu`/`execQemu` arg arrays, and `qemuImg.raw()` are passed to QEMU
  verbatim. They are privileged configuration — treat them exactly as you
  would a shell command you are about to run as the current user.
- **A guest reaching the network.** User-mode networking and any `hostfwd`
  you configure expose services to/from the guest. That is your policy to
  design.
- **Privilege you hand QEMU.** Running as root, device passthrough, `tap`
  networking, host filesystem passthrough, and a public VNC/SPICE/monitor are
  all things QEMU can do and this library will not stop if you ask for them.

---

## 2. Trust boundaries

```
   caller code (your app)                         ← you decide what is trusted here
        │
        │  VmConfig / command names / qemu-img paths
        ▼
   qemu-portable API                                  ← validates + escapes typed fields,
        │                                            enforces the command allowlist,
        │  argv array (shell: false)                 injects -L, keeps QMP local-only
        ▼
   vendored QEMU process  ── reads ──▶  disk images, ISOs, kernels, firmware   ← UNTRUSTED
        │                                            (QEMU's own attack surface)
        │  local Unix socket
        ▼
   QMP control channel                            ← privileged; local IPC only, never TCP
```

The library hardens the middle boundary (caller → QEMU argv) and the QMP
channel. It cannot harden the boundary between QEMU and the images/guest it
runs — that is inherent to running a VM.

### Which inputs are validated vs. passed through

| Input | Handling |
|---|---|
| `command` (resolver/process) | **Contained**, not allowlisted: any name is allowed, but it must resolve inside the package `bin/` (no path separators/`..`/absolute) → traversal throws `QemuInvalidCommandError`. |
| `disk.path`, `disk.format`, `disk.interface` | **Escaped** (commas doubled) before entering the `-drive` option string. |
| `network.hostForwards[].protocol` | **Validated** to `tcp`/`udp`. |
| `network.hostForwards[].hostPort` / `guestPort` | **Validated** integer in `0..65535`. |
| `network.hostForwards[].hostAddress` / `guestAddress` | **Validated** against a conservative IPv4/IPv6/hostname character set (no commas/spaces). |
| `qmp.socketPath` | **Escaped**; only ever emitted as a `unix:` socket. |
| `disk.encryption.passphrase` (`createVm`) / `encryption.passphrase` (`qemuImg`) | **Never emitted to argv.** Written verbatim to a `0600` file in a `0700` temp dir, referenced by a `secret` object, and deleted on VM exit / command completion. |
| `disk.encryption.passphraseFile` | **Escaped** into the `secret` object. The file is caller-owned: used as-is, contents never inspected, never deleted. |
| Secret object ids | **Generated internally** (`sec0`, `sec-disk<n>`) and **validated** against `[A-Za-z0-9_-]+`, so they cannot terminate an option or start a new one. |
| `encryption` cipher/hash/ivgen parameters | **Typed unions**, emitted as `-o` sub-options; `iterTime` is validated as a non-negative integer. |
| `name` | **Escaped**. |
| `machine`, `cpu`, `memory`, `smp`, `serial`, `kernel.*`, `cdrom` | Emitted as their **own argv tokens** — they cannot inject *other* options, but their content is otherwise trusted as configuration. |
| `extraArgs` | **Passed through verbatim.** Escape hatch — untrusted input must never reach it. |

---

## 3. Hardening checklist

Use this when integrating the library into a service that handles untrusted
input.

- [ ] **Never forward untrusted strings into `extraArgs`, `spawnQemu`/
      `execQemu` args, or `qemuImg.raw()`.** These are raw QEMU arguments.
- [ ] **Treat the guest and its images as hostile.** Run QEMU as a dedicated
      unprivileged user; do not run your Node process (or QEMU) as root.
- [ ] **Prefer hardware virtualization** (`acceleration: "auto"` →
      `kvm`/`hvf`/`whpx`). TCG has no hardware isolation. Check
      `getQemuDiagnostics().acceleratorHints` and surface a warning when you
      fall back to TCG.
- [ ] **Keep networking off unless needed.** The default is no NIC. When you
      enable `type: "user"`, expose only the `hostForwards` you require and
      bind them to `127.0.0.1` (the default `hostAddress`), never `0.0.0.0`.
- [ ] **Keep QMP local.** Use a per-VM `socketPath` in a directory only your
      user can read; the client has no TCP option by design. Do not proxy the
      socket onto a network interface.
- [ ] **Treat the guest-agent socket like QMP.** `guestAgent`/`vm.exec` expose
      a local Unix socket that runs commands in the guest (`guest-exec`). The
      auto-provisioned path lives under a private `mkdtemp` directory; if you
      set your own `socketPath`, keep it in a directory only your user can
      read, and never expose it over a network. Note that `guest-exec` runs in
      the *guest*, not the host — but it is still a privileged channel.
- [ ] **Audit before you launch.** Call `vm.build().args` and log/inspect the
      exact argv, especially if any field derives from external input.
- [ ] **Keep disk passphrases out of your own logs and argv.** The library
      keeps them off QEMU's command line, but `vm.build().args` still contains
      the *path* to the key file — and anything you pass to `extraArgs` is
      verbatim. Never hand a passphrase to `extraArgs` or `qemuImg.raw()`.
      Prefer `{ passphraseFile }` pointing at a file your process never writes
      (a tmpfs/ramdisk mount, or a secret injected by your orchestrator) when
      you do not want the key touching disk at all.
- [ ] **Check a passphrase with `verifyPassphrase()`, not `info()`.**
      `qemuImg.info()` reads the LUKS header without deriving a key and
      succeeds under a wrong passphrase; treating it as an auth check is a
      silent accept-anything. Note that `verifyPassphrase` deliberately costs
      real CPU time, so rate-limit it if it is reachable from untrusted input.
- [ ] **Do not let untrusted input choose an image's `format`.** Encrypted
      images must declare their format (they cannot be probed), and a format
      an attacker picks changes which driver parses the file.
- [ ] **Add OS-level containment** if you need a real boundary: seccomp, a
      restricted user, cgroups/ulimits, a network namespace, or nesting the
      whole thing inside another VM. QEMU's own `-sandbox` may also apply.
- [ ] **Set timeouts** on short-running commands (`timeoutMs`) and wire an
      `AbortSignal` into long-running VMs so a hung process can be reclaimed.
- [ ] **Keep QEMU current.** Security fixes ship as patch releases of the
      binary packages; the vendored version is in each package's
      `build-info.json`. Track it.

---

## 4. Safe patterns

### Audit the exact command line before starting

```ts
import { createVm } from "qemu-portable";

const vm = createVm(configFromRequest);
const { command, args } = vm.build();   // pure: nothing has run yet
logger.info({ command, args }, "launching qemu");
// ...only then:
const proc = vm.start({ stdio: "pipe", timeoutMs: 5 * 60_000 });
```

### Networking limited to one loopback forward

```ts
network: {
  type: "user",
  hostForwards: [
    // hostAddress defaults to 127.0.0.1; never use 0.0.0.0.
    { protocol: "tcp", hostPort: 2222, guestPort: 22 },
  ],
}
```

### QMP on a private per-VM socket

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QmpClient, createVm } from "qemu-portable";

const dir = mkdtempSync(join(tmpdir(), "vm-"));   // 0700 by default
const socketPath = join(dir, "qmp.sock");

const vm = createVm({ /* ... */, qmp: { enabled: true, socketPath } });
const proc = vm.start();

const qmp = new QmpClient({ socketPath, timeoutMs: 10_000 });
await qmp.connect();
await qmp.execute("system_powerdown");
await qmp.close();
```

### Anti-patterns (do not do this)

```ts
// ❌ Untrusted input into the raw escape hatch.
createVm({ target: "x86_64", extraArgs: req.body.qemuFlags });

// ❌ Untrusted command name (rejected now, but never build on this shape).
spawnQemu(req.query.tool, args);

// ❌ Exposing a forward or QMP to the world.
hostForwards: [{ protocol: "tcp", hostAddress: "0.0.0.0", hostPort: 22, guestPort: 22 }];

// ❌ Passphrase on the command line — readable by any local user via `ps`.
createVm({ target: "x86_64", extraArgs: ["-object", `secret,id=s,data=${passphrase}`] });

// ❌ info() is not a passphrase check: this succeeds with the wrong key.
const ok = await qemuImg.info(path, { format: "qcow2", encryption: { passphrase } });
```

---

## 5. Hardening history

Security fixes applied to the library itself (as opposed to QEMU updates):

| Area | Issue | Resolution |
|---|---|---|
| VM builder (`args.ts`) | `hostForwards` addresses/protocol were interpolated into the `-netdev` string unescaped, allowing option injection (up to `guestfwd=...-cmd:` host command execution) via a comma. | Validate protocol (`tcp`/`udp`), ports (`0..65535`), and addresses (conservative IPv4/IPv6/hostname set); escape all interpolated `-drive` fields. |
| Resolver (`resolve.ts`) | `command` had no runtime check; a `../`-bearing string could resolve/spawn an arbitrary host binary. | Require the command to name a binary inside `bin/` (path-containment, not an allowlist) via `assertContainedCommandName`; throw `QemuInvalidCommandError` on traversal. Command *selection* is left to the caller. |
| QMP client (`qmp/client.ts`) | Responses were correlated FIFO; a timed-out request removed from the queue misaligned all later responses. | Correlate by per-command `id`. |
| QMP framer (`qmp/protocol.ts`) | Unbounded line buffering allowed a memory-exhaustion DoS from a hostile peer. | Cap the unterminated-line buffer (`maxLineBytes`); throw `QmpProtocolError` when exceeded. |

Each fix has a dedicated regression test in `packages/qemu/test/`.
