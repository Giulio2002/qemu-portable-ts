#!/usr/bin/env bash
# Builds QEMU from the pinned source and assembles a Linux platform package.
#
# Usage:
#   scripts/build-qemu-linux.sh <package-dir>
#   scripts/build-qemu-linux.sh packages/qemu-linux-x64
#
# Requirements (build host, not runtime): gcc/clang, make, ninja, meson,
# python3, pkg-config, libglib2.0-dev, libpixman-1-dev, libslirp-dev,
# patchelf, xz.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${1:?usage: build-qemu-linux.sh <package-dir>}"
PACKAGE_DIR="$(cd "$PACKAGE_DIR" && pwd)"

# Single source of truth for the QEMU pin.
QEMU_VERSION="$(cat "$REPO_ROOT/third_party/qemu/QEMU_VERSION")"
QEMU_GIT_REF="v${QEMU_VERSION}"
TARBALL="qemu-${QEMU_VERSION}.tar.xz"
CHECKSUM_FILE="$REPO_ROOT/third_party/qemu/checksums/${TARBALL}.sha256"
TARGET_LIST="x86_64-softmmu,aarch64-softmmu"
BINARIES=(qemu-system-x86_64 qemu-system-aarch64 qemu-img)

WORK_DIR="${QEMU_BUILD_DIR:-$REPO_ROOT/third_party/qemu/source}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# --- Fetch and verify pinned source -----------------------------------------
if [[ ! -f "$TARBALL" ]]; then
  echo "Downloading $TARBALL ..."
  curl -fL --retry 3 -o "$TARBALL" "https://download.qemu.org/${TARBALL}"
fi
echo "Verifying source checksum ..."
sha256sum -c "$CHECKSUM_FILE"
SOURCE_SHA256="$(cut -d' ' -f1 "$CHECKSUM_FILE")"

if [[ ! -d "qemu-${QEMU_VERSION}" ]]; then
  tar xf "$TARBALL"
fi
cd "qemu-${QEMU_VERSION}"

# --- Apply repo patches (if any) ---------------------------------------------
PATCHES=()
shopt -s nullglob
for patch in "$REPO_ROOT"/third_party/qemu/patches/*.patch; do
  echo "Applying $(basename "$patch") ..."
  patch -p1 --forward < "$patch" || true
  PATCHES+=("$(basename "$patch")")
done
shopt -u nullglob

# --- Configure and build ------------------------------------------------------
CONFIGURE_ARGS=(
  "--target-list=${TARGET_LIST}"
  "--disable-docs"
  "--disable-werror"
  "--disable-gtk"
  "--disable-sdl"
  "--enable-slirp"
  "--prefix=/usr"
)
mkdir -p build && cd build
../configure "${CONFIGURE_ARGS[@]}"
make -j"$(nproc)"

# --- Assemble the package -----------------------------------------------------
DESTDIR="$PWD/dest"
rm -rf "$DESTDIR"
make install "DESTDIR=$DESTDIR"

rm -rf "$PACKAGE_DIR/bin" "$PACKAGE_DIR/lib" "$PACKAGE_DIR/share/qemu"
mkdir -p "$PACKAGE_DIR/bin" "$PACKAGE_DIR/lib" "$PACKAGE_DIR/share"

for bin in "${BINARIES[@]}"; do
  cp "$DESTDIR/usr/bin/$bin" "$PACKAGE_DIR/bin/"
  strip --strip-unneeded "$PACKAGE_DIR/bin/$bin" || true
done
cp -R "$DESTDIR/usr/share/qemu" "$PACKAGE_DIR/share/qemu"

# --- Bundle runtime deps and fix RPATH -----------------------------------------
node --experimental-strip-types "$REPO_ROOT/scripts/collect-runtime-deps.ts" "$PACKAGE_DIR"
for bin in "${BINARIES[@]}"; do
  patchelf --set-rpath '$ORIGIN/../lib' "$PACKAGE_DIR/bin/$bin"
done

# --- Metadata -------------------------------------------------------------------
node --experimental-strip-types "$REPO_ROOT/scripts/generate-build-info.ts" \
  "$PACKAGE_DIR" \
  --qemu-version "$QEMU_VERSION" \
  --git-ref "$QEMU_GIT_REF" \
  --source-sha256 "$SOURCE_SHA256" \
  --configure-args "$(IFS=';'; echo "${CONFIGURE_ARGS[*]}")" \
  --patches "$(IFS=';'; echo "${PATCHES[*]:-}")"

node --experimental-strip-types "$REPO_ROOT/scripts/verify-binary-package.ts" "$PACKAGE_DIR"
echo "Package assembled: $PACKAGE_DIR"
