# third_party/qemu — pinned QEMU source

This directory pins the exact QEMU source every binary package is built from.

```
QEMU_VERSION     single source of truth for the pinned upstream version
checksums/       SHA-256 for each pinned source tarball (sha256sum -c format)
patches/         patches applied on top of the pinned source (currently none)
source/          build-time working directory (gitignored; tarball + tree)
```

## Current pin

- **Version:** 10.0.2 (`v10.0.2`)
- **Tarball:** `https://download.qemu.org/qemu-10.0.2.tar.xz`
- **SHA-256:** `ef786f2398cb5184600f69aef4d5d691efd44576a3cff4126d38d4c6fec87759`

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
