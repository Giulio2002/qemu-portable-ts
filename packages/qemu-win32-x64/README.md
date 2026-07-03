# qemu-portable-win32-x64

Vendored QEMU binaries for Windows x64. This package is an optional
dependency of [`qemu-portable`](https://www.npmjs.com/package/qemu-portable) and is
not meant to be used directly — the core package resolves and runs the
binaries in here.

## Contents (populated by the release build)

```
  bin/qemu-system-x86_64.exe
  bin/qemu-system-aarch64.exe
  bin/qemu-img.exe
  bin/*.dll       bundled dynamic libraries (next to the executables)
  share/qemu/     firmware, BIOS, and keymap data (used via -L)
  licenses/       GPL-2.0, QEMU license notes, third-party notices, source offer
  build-info.json QEMU version, git ref, configure args, source checksum
```

The bin/, and share/qemu/ directories in the repository are
placeholders; they are filled by `scripts/build-qemu-*` in CI before
publishing. Publishing is blocked unless `scripts/verify-binary-package.ts`
and `scripts/verify-license-files.ts` pass.

## License

The QEMU binaries in this package are distributed under **GPL-2.0-only**.
See `licenses/` for the full text, third-party notices, and the written
source offer.
