# COMPLIANCE

This project redistributes QEMU binaries inside npm packages. Compliance is
a **blocking release gate**: `scripts/verify-license-files.ts` and
`scripts/verify-binary-package.ts` run in CI and refuse to publish a binary
package that is missing any of the artifacts below.

## QEMU version

The pinned upstream version is recorded in `third_party/qemu/QEMU_VERSION`
(currently **10.0.2**, git ref `v10.0.2`) with the source tarball SHA-256 in
`third_party/qemu/checksums/`. Every binary package additionally records its
exact provenance in `build-info.json`:

```json
{
  "qemuVersion": "10.0.2",
  "qemuGitRef": "v10.0.2",
  "builtAt": "…",
  "targets": ["qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"],
  "configureArgs": ["--target-list=x86_64-softmmu,aarch64-softmmu", "…"],
  "runtimeDependencies": ["…"],
  "sourceArchiveSha256": "ef786f2398cb5184600f69aef4d5d691efd44576a3cff4126d38d4c6fec87759",
  "patches": []
}
```

The QEMU version is never encoded in npm package names or versions; all
packages of one release share a single npm version.

## License split

| Component | License |
|---|---|
| `@org/qemu` (TypeScript wrapper, this repo's tooling) | MIT |
| `@org/qemu-*` (binary packages) | GPL-2.0-only |

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
| `scripts/build-qemu-linux.sh` | Build + assemble Linux packages (RPATH `$ORIGIN/../lib`) |
| `scripts/build-qemu-macos.sh` | Build + assemble macOS packages (`@loader_path` install names, hvf entitlement) |
| `scripts/build-qemu-windows.ps1` | Build + assemble Windows package (DLLs beside EXEs) |
| `scripts/collect-runtime-deps.ts` | Bundle redistributable dynamic libraries, regenerate third-party notices |
| `scripts/generate-build-info.ts` | Write `build-info.json` |
| `scripts/verify-binary-package.ts` | Structural + metadata verification (release gate) |
| `scripts/verify-license-files.ts` | License/compliance verification (release gate) |

## Release checklist (compliance portion)

- [ ] license files present in every binary package (CI-gated)
- [ ] `THIRD-PARTY-NOTICES.txt` regenerated, no UNKNOWN licenses (CI-gated)
- [ ] source archive + patches + build scripts attached to the GitHub Release
- [ ] `build-info.json` identifies QEMU version, patches, and source checksum (CI-gated)
- [ ] release notes state the QEMU upstream version and platform list
- [ ] legal sign-off on package metadata and README wording (manual, before first public release and on wording changes)
