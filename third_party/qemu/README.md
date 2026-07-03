# third_party/qemu — pinned QEMU source

This directory pins the exact QEMU source every binary package is built from.

```
QEMU_VERSION     single source of truth for the pinned upstream version
checksums/       SHA-256 for each pinned source tarball (sha256sum -c format)
patches/         patches applied on top of the pinned source (currently none)
source/          build-time working directory (gitignored; tarball + tree)
```

## Current pin

- **Version:** 11.0.1 (`v11.0.1`)
- **Tarball:** `https://download.qemu.org/qemu-11.0.1.tar.xz`
- **SHA-256:** `0d235f5820278d914a3155ec27af8e4258d697ea892895570807d69c0cb8cd64`

## Version policy

- The project tracks the **latest upstream stable release** of QEMU. There is
  exactly one pin at a time; every platform package of a given npm release is
  built from it, and `scripts/verify-binary-package.ts` refuses a package
  whose `build-info.json` disagrees with `QEMU_VERSION`.
- **New stable series** (e.g. 11.0 → 11.1): bump within one month of the
  upstream release, after the full build matrix and boot smoke tests pass.
- **Point/security releases on the pinned series** (e.g. 11.0.1 → 11.0.2):
  bump within two weeks; security fixes affecting the shipped configuration
  (x86_64/aarch64 softmmu, slirp networking) get an out-of-band npm release.
- The npm package version bumps independently and never encodes the QEMU
  version; `build-info.json` and the release notes record it.

## Updating the pin

1. Edit `QEMU_VERSION`.
2. Download the new tarball, verify it against the QEMU release announcement
   signature, and add `checksums/qemu-<version>.tar.xz.sha256`.
3. Rebase any files in `patches/` onto the new source.
4. Run the full build matrix (`build-binaries.yml`) and smoke tests.
5. Record the new QEMU version in the release notes; the npm package version
   bumps independently (the QEMU version never appears in package names).

## Compliance

The tarball, patches, and build scripts are published as GitHub Release
assets for every npm release so that the GPL-2.0 corresponding-source
requirement is met. See `COMPLIANCE.md` at the repository root and
`licenses/SOURCE-OFFER.txt` inside each binary package.
