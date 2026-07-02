# Security Policy

## Supported versions

Only the latest published minor release line of `@org/qemu` and its platform
packages receives security updates. The vendored QEMU version for each
release is recorded in every platform package's `build-info.json` and in the
release notes.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories on this
repository (Security → "Report a vulnerability"), or by emailing the
maintainers listed in `package.json`. Please do not open public issues for
security reports. We aim to acknowledge reports within 72 hours.

## QEMU update policy

- We track upstream QEMU stable releases and CVE announcements.
- Security fixes in the vendored QEMU version are shipped as a patch release
  of **all** packages (binary packages first, then the core package), even
  when the TypeScript wrapper is unchanged.
- The pinned QEMU version and source checksum live in `third_party/qemu/`;
  every release publishes the corresponding source.

## QEMU is not automatically a sandbox

Do not treat this package as a security boundary:

- QEMU is a large native process. Running it against **untrusted disk
  images, ISOs, kernels, initrds, firmware, or guest code** exposes you to
  QEMU parser and device-emulation vulnerabilities.
- In TCG (software emulation) mode there is no hardware isolation between
  guest and host beyond ordinary process boundaries.
- Guest-facing network traffic and QMP clients are untrusted inputs.
- `extraArgs` passed by callers reach QEMU verbatim — treat them as
  privileged configuration.

If you need containment, add your own layers (dedicated unprivileged user,
seccomp/sandbox profiles, VMs-in-VMs, network isolation). Never run QEMU as
root through this library.

## Safe defaults this library enforces

- Processes are spawned with `shell: false` and argv arrays — never string
  concatenation through a shell.
- VM defaults: `-display none`, no NIC unless requested, user-mode
  networking only, host accelerator with tcg fallback.
- QMP is exposed **only** over local IPC (Unix domain sockets); the client
  has no host/port options and helpers never bind `0.0.0.0`.
- The resolver never silently falls back to a system QEMU on PATH.

## Safe QMP guidance

QMP is a privileged control interface equivalent to full control of the VM.
Keep sockets in directories with restrictive permissions, prefer per-VM
socket paths in fresh temp directories, and never proxy QMP to a network
interface.

## Supply chain

Releases are published from CI only, with npm provenance enabled and 2FA
required on the npm organization. The QEMU source tarball checksum is pinned
in-repo (`third_party/qemu/checksums/`) and verified at build time; binary
packages are smoke-tested from `npm pack` tarballs before publishing. None
of the published packages run install scripts.
