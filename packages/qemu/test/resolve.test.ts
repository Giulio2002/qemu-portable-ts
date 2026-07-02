import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { QemuBinaryNotFoundError, UnsupportedPlatformError } from "../src/errors";
import { getHostPlatform } from "../src/platform";
import { listAvailableBinaries, resolveQemuBinary } from "../src/resolve";
import { makeFakePlatformPackage } from "./helpers";

test("getHostPlatform maps known platform/arch combinations", () => {
  assert.equal(getHostPlatform({ platform: "linux", arch: "x64", libc: "glibc" }), "linux-x64");
  assert.equal(getHostPlatform({ platform: "linux", arch: "x64", libc: "musl" }), "linux-x64-musl");
  assert.equal(getHostPlatform({ platform: "linux", arch: "arm64", libc: "glibc" }), "linux-arm64");
  assert.equal(getHostPlatform({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(getHostPlatform({ platform: "darwin", arch: "x64" }), "darwin-x64");
  assert.equal(getHostPlatform({ platform: "win32", arch: "x64" }), "win32-x64");
});

test("getHostPlatform throws UnsupportedPlatformError with actionable message", () => {
  assert.throws(
    () => getHostPlatform({ platform: "freebsd", arch: "x64" }),
    (err: Error) => {
      assert.ok(err instanceof UnsupportedPlatformError);
      assert.equal(err.code, "ERR_QEMU_UNSUPPORTED_PLATFORM");
      assert.match(err.message, /freebsd-x64/);
      assert.match(err.message, /Supported platforms/);
      return true;
    }
  );
});

test("resolveQemuBinary finds a vendored binary via platform override", () => {
  const fake = makeFakePlatformPackage("linux-x64", ["qemu-img", "qemu-system-x86_64"]);
  const resolved = resolveQemuBinary("qemu-img", {
    platform: "linux-x64",
    searchPaths: [fake.searchPath],
  });
  assert.equal(resolved.command, "qemu-img");
  assert.equal(resolved.path, join(fake.packageRoot, "bin", "qemu-img"));
  assert.equal(resolved.packageName, "@org/qemu-linux-x64");
  assert.equal(resolved.hostPlatform, "linux-x64");
  assert.equal(resolved.qemuDataDir, join(fake.packageRoot, "share", "qemu"));
  assert.equal(resolved.version, "10.0.2");
  assert.equal(resolved.buildInfo?.qemuGitRef, "v10.0.2");
});

test("resolveQemuBinary appends .exe for win32 platforms", () => {
  const fake = makeFakePlatformPackage("win32-x64", ["qemu-img"]);
  const resolved = resolveQemuBinary("qemu-img", {
    platform: "win32-x64",
    searchPaths: [fake.searchPath],
  });
  assert.ok(resolved.path.endsWith(join("bin", "qemu-img.exe")));
});

test("resolveQemuBinary throws a clear error when the platform package is missing", () => {
  assert.throws(
    () =>
      resolveQemuBinary("qemu-img", {
        platform: "linux-arm64",
        searchPaths: ["/nonexistent-search-root"],
      }),
    (err: Error) => {
      assert.ok(err instanceof QemuBinaryNotFoundError);
      assert.equal(err.code, "ERR_QEMU_BINARY_NOT_FOUND");
      assert.match(err.message, /@org\/qemu-linux-arm64/);
      assert.match(err.message, /--omit=optional/);
      assert.match(err.message, /--no-optional/);
      return true;
    }
  );
});

test("resolveQemuBinary throws when the package exists but lacks the binary", () => {
  const fake = makeFakePlatformPackage("linux-x64", ["qemu-img"]);
  assert.throws(
    () =>
      resolveQemuBinary("qemu-system-riscv64", {
        platform: "linux-x64",
        searchPaths: [fake.searchPath],
      }),
    (err: Error) => {
      assert.ok(err instanceof QemuBinaryNotFoundError);
      assert.match(err.message, /qemu-system-riscv64/);
      assert.match(err.message, /diagnostics/);
      return true;
    }
  );
});

test("listAvailableBinaries lists only known commands present in bin/", () => {
  const fake = makeFakePlatformPackage("linux-x64", [
    "qemu-img",
    "qemu-system-x86_64",
    "qemu-system-aarch64",
  ]);
  const binaries = listAvailableBinaries({
    platform: "linux-x64",
    searchPaths: [fake.searchPath],
  });
  const commands = binaries.map((b) => b.command).sort();
  assert.deepEqual(commands, ["qemu-img", "qemu-system-aarch64", "qemu-system-x86_64"]);
});

test("listAvailableBinaries returns empty when no package is installed", () => {
  const binaries = listAvailableBinaries({
    platform: "linux-arm64",
    searchPaths: ["/nonexistent-search-root"],
  });
  assert.deepEqual(binaries, []);
});

test("preferSystem falls back to vendored binary when PATH has no match", () => {
  const fake = makeFakePlatformPackage("linux-x64", ["qemu-img"]);
  const resolved = resolveQemuBinary("qemu-img", {
    platform: "linux-x64",
    searchPaths: [fake.searchPath],
    preferSystem: true,
    env: { PATH: "/nonexistent-bin-dir" },
  });
  assert.equal(resolved.packageName, "@org/qemu-linux-x64");
});

test("preferSystem uses PATH binary when present", () => {
  const fake = makeFakePlatformPackage("linux-x64", ["qemu-img"]);
  const pathDir = join(fake.packageRoot, "bin");
  const resolved = resolveQemuBinary("qemu-img", {
    platform: "linux-x64",
    searchPaths: ["/nonexistent-search-root"],
    preferSystem: true,
    env: { PATH: pathDir },
  });
  assert.equal(resolved.packageName, "(system PATH)");
  assert.equal(resolved.path, join(pathDir, "qemu-img"));
});
