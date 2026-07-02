# @org/qemu-darwin-x64

Vendored QEMU binaries for macOS x64. This package is an optional
dependency of [`@org/qemu`](https://www.npmjs.com/package/@org/qemu) and is
not meant to be used directly — the core package resolves and runs the
binaries in here.

## Contents (populated by the release build)

```
  bin/qemu-system-x86_64
  bin/qemu-system-aarch64
  bin/qemu-img
  lib/            bundled dynamic libraries
  share/qemu/     firmware, BIOS, and keymap data (used via -L)
  licenses/       GPL-2.0, QEMU license notes, third-party notices, source offer
  build-info.json QEMU version, git ref, configure args, source checksum
```

The bin/, lib/, and share/qemu/ directories in the repository are
placeholders; they are filled by `scripts/build-qemu-*` in CI before
publishing. Publishing is blocked unless `scripts/verify-binary-package.ts`
and `scripts/verify-license-files.ts` pass.

## License

The QEMU binaries in this package are distributed under **GPL-2.0-only**.
See `licenses/` for the full text, third-party notices, and the written
source offer.
