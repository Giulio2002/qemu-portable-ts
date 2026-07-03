# COMPLIANCE

This project redistributes QEMU binaries inside npm packages. Compliance is
a **blocking release gate**: `scripts/verify-license-files.ts` and
`scripts/verify-binary-package.ts` run in CI and refuse to publish a binary
package that is missing any of the artifacts below.

## QEMU version

The pinned upstream version is recorded in `third_party/qemu/QEMU_VERSION`
(currently **11.0.1**, git ref `v11.0.1`) with the source tarball SHA-256 in
`third_party/qemu/checksums/`. Every binary package additionally records its
exact provenance in `build-info.json`:

```json
{
  "qemuVersion": "11.0.1",
  "qemuGitRef": "v11.0.1",
  "builtAt": "…",
  "targets": ["qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"],
  "configureArgs": ["--target-list=x86_64-softmmu,aarch64-softmmu", "…"],
  "runtimeDependencies": ["…"],
  "sourceArchiveSha256": "0d235f5820278d914a3155ec27af8e4258d697ea892895570807d69c0cb8cd64",
  "patches": []
}
```

The QEMU version is never encoded in npm package names or versions; all
packages of one release share a single npm version.
`verify-binary-package.ts` rejects any package whose `build-info.json`
version disagrees with the pin, so a release can never mix QEMU versions.
The cadence for tracking upstream stable and security releases is stated in
`third_party/qemu/README.md` (§ Version policy).

## License split

| Component | License |
|---|---|
| `qemu-portable` (TypeScript wrapper, this repo's tooling) | MIT |
| `qemu-portable-*` (binary packages) | GPL-2.0-only |

## Files included in every binary package

```
licenses/GPL-2.0.txt              full GNU GPL v2 text
licenses/QEMU-LICENSE.txt         QEMU licensing summary and upstream pointer
licenses/THIRD-PARTY-NOTICES.txt  bundled dynamic libraries + licenses
                                  (regenerated at build time by
                                  scripts/collect-runtime-deps.ts)
licenses/SOURCE-OFFER.txt         written offer for corresponding source
build-info.json                   exact build provenance (see above)
```

## Source availability

For every published release, the complete corresponding source is available
in two ways:

1. **GitHub Release assets** on the matching `v*` tag:
   `qemu-<version>.tar.xz` (checksum-verified against the in-repo pin),
   `patches/`, `build-scripts/`, and `checksums.txt`. Assembled by
   `.github/workflows/release.yml`.
2. **The repository itself** at the same tag: `third_party/qemu/` (pin,
   checksums, patches) plus `scripts/build-qemu-*` reproduce each binary
   package from source.

`licenses/SOURCE-OFFER.txt` inside each binary package additionally contains
a written offer valid for at least three years.

## Build script reference

| Script | Purpose |
|---|---|
| `scripts/build-qemu-linux.sh` | Build + assemble Linux packages, glibc and musl/Alpine (RPATH `$ORIGIN/../lib`) |
| `scripts/build-qemu-macos.sh` | Build + assemble macOS packages (`@loader_path` install names, hvf entitlement) |
| `scripts/build-qemu-windows.ps1` | Build + assemble Windows packages (DLLs beside EXEs, WHPX on x64) |
| `scripts/prune-firmware.ts` | Drop firmware for architectures the package ships no emulator for |
| `scripts/collect-runtime-deps.ts` | Bundle redistributable dynamic libraries, regenerate third-party notices |
| `scripts/generate-build-info.ts` | Write `build-info.json` (provenance + feature flags) |
| `scripts/verify-binary-package.ts` | Structural, metadata, pin-match, and self-containedness verification (release gate) |
| `scripts/verify-license-files.ts` | License/compliance verification (release gate) |
| `scripts/boot-test.ts` | Boot a real guest to serial `BOOT-OK` under TCG (release gate) |
| `scripts/make-placeholder-package.ts` | Installable no-binary placeholders for unbuilt platforms (MIT, no GPL content) |

## Release checklist (compliance portion)

- [ ] license files present in every binary package (CI-gated)
- [ ] `THIRD-PARTY-NOTICES.txt` regenerated, no UNKNOWN licenses (CI-gated)
- [ ] source archive + patches + build scripts attached to the GitHub Release
- [ ] `build-info.json` identifies QEMU version, patches, and source checksum (CI-gated)
- [ ] release notes state the QEMU upstream version and platform list
- [ ] legal sign-off on package metadata and README wording (manual, before first public release and on wording changes)
