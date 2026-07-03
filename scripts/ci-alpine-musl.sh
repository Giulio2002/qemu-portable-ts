#!/bin/sh
# Full musl build + verification pipeline, run INSIDE an Alpine container by
# build-binaries.yml (docker run, workspace mounted at /workspace).
#
# The job cannot use GitHub's `container:` option: JavaScript actions
# (checkout, upload-artifact) only work in Alpine containers on x64 runners,
# not arm64. Driving docker from the glibc host keeps the actions on the
# host and everything musl in here.
#
# Runs in the node:22-alpine image — the OFFICIAL Node build, because
# Alpine's distro nodejs is compiled without TypeScript strip-types support
# (ERR_NO_TYPESCRIPT) and every repo script relies on it.
#
# Usage: sh scripts/ci-alpine-musl.sh <package-dir>
set -eu

PACKAGE_DIR="${1:?usage: ci-alpine-musl.sh <package-dir>}"

node --version

apk add --no-cache \
  bash curl git tar xz coreutils build-base linux-headers \
  ninja meson pkgconf python3 py3-setuptools py3-pip \
  glib-dev pixman-dev libslirp-dev patchelf

bash scripts/build-qemu-linux.sh "$PACKAGE_DIR"

node --experimental-strip-types scripts/verify-license-files.ts "$PACKAGE_DIR"

npm ci
npm run build
node --experimental-strip-types scripts/link-platform-package.ts "$PACKAGE_DIR"
node --experimental-strip-types scripts/smoke-test.ts
node --experimental-strip-types scripts/boot-test.ts
