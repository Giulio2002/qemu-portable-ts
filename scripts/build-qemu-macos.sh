#!/usr/bin/env bash
# Builds QEMU from the pinned source and assembles a macOS platform package.
#
# Usage:
#   scripts/build-qemu-macos.sh packages/qemu-darwin-arm64
#
# Requirements (build host): Xcode CLT, ninja, meson, pkg-config, glib,
# pixman, libslirp (build-time; their dylibs are bundled into lib/).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${1:?usage: build-qemu-macos.sh <package-dir>}"
PACKAGE_DIR="$(cd "$PACKAGE_DIR" && pwd)"

QEMU_VERSION="$(cat "$REPO_ROOT/third_party/qemu/QEMU_VERSION")"
QEMU_GIT_REF="v${QEMU_VERSION}"
TARBALL="qemu-${QEMU_VERSION}.tar.xz"
CHECKSUM_FILE="$REPO_ROOT/third_party/qemu/checksums/${TARBALL}.sha256"
TARGET_LIST="x86_64-softmmu,aarch64-softmmu"
BINARIES=(qemu-system-x86_64 qemu-system-aarch64 qemu-img)

WORK_DIR="${QEMU_BUILD_DIR:-$REPO_ROOT/third_party/qemu/source}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

if [[ ! -f "$TARBALL" ]]; then
  echo "Downloading $TARBALL ..."
  curl -fL --retry 3 -o "$TARBALL" "https://download.qemu.org/${TARBALL}"
fi
echo "Verifying source checksum ..."
shasum -a 256 -c "$CHECKSUM_FILE"
SOURCE_SHA256="$(cut -d' ' -f1 "$CHECKSUM_FILE")"

if [[ ! -d "qemu-${QEMU_VERSION}" ]]; then
  tar xf "$TARBALL"
fi
cd "qemu-${QEMU_VERSION}"

PATCHES=()
shopt -s nullglob
for patch in "$REPO_ROOT"/third_party/qemu/patches/*.patch; do
  echo "Applying $(basename "$patch") ..."
  patch -p1 --forward < "$patch" || true
  PATCHES+=("$(basename "$patch")")
done
shopt -u nullglob

CONFIGURE_ARGS=(
  "--target-list=${TARGET_LIST}"
  "--disable-docs"
  "--disable-werror"
  "--disable-gtk"
  "--disable-sdl"
  "--enable-hvf"
  "--enable-slirp"
  "--prefix=/usr"
)
mkdir -p build && cd build
../configure "${CONFIGURE_ARGS[@]}"
make -j"$(sysctl -n hw.ncpu)"

DESTDIR="$PWD/dest"
rm -rf "$DESTDIR"
make install "DESTDIR=$DESTDIR"

rm -rf "$PACKAGE_DIR/bin" "$PACKAGE_DIR/lib" "$PACKAGE_DIR/share/qemu"
mkdir -p "$PACKAGE_DIR/bin" "$PACKAGE_DIR/lib" "$PACKAGE_DIR/share"

for bin in "${BINARIES[@]}"; do
  cp "$DESTDIR/usr/bin/$bin" "$PACKAGE_DIR/bin/"
done
cp -R "$DESTDIR/usr/share/qemu" "$PACKAGE_DIR/share/qemu"
node --experimental-strip-types "$REPO_ROOT/scripts/prune-firmware.ts" "$PACKAGE_DIR"

# Bundle dylibs and rewrite install names to @loader_path/../lib.
node --experimental-strip-types "$REPO_ROOT/scripts/collect-runtime-deps.ts" "$PACKAGE_DIR"

# Re-sign after install_name_tool edits (ad-hoc; release CI replaces this
# with a Developer ID identity + notarization).
for bin in "${BINARIES[@]}"; do
  codesign --force --sign - --entitlements "$REPO_ROOT/scripts/qemu-hvf.entitlements" \
    "$PACKAGE_DIR/bin/$bin" 2>/dev/null ||
    codesign --force --sign - "$PACKAGE_DIR/bin/$bin"
done
for dylib in "$PACKAGE_DIR"/lib/*.dylib; do
  [[ -e "$dylib" ]] && codesign --force --sign - "$dylib"
done

node --experimental-strip-types "$REPO_ROOT/scripts/generate-build-info.ts" \
  "$PACKAGE_DIR" \
  --qemu-version "$QEMU_VERSION" \
  --git-ref "$QEMU_GIT_REF" \
  --source-sha256 "$SOURCE_SHA256" \
  --configure-args "$(IFS=';'; echo "${CONFIGURE_ARGS[*]}")" \
  --patches "$(IFS=';'; echo "${PATCHES[*]:-}")"

node --experimental-strip-types "$REPO_ROOT/scripts/verify-binary-package.ts" "$PACKAGE_DIR"
echo "Package assembled: $PACKAGE_DIR"
