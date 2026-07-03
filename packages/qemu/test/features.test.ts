import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { checkHostSupport, getQemuFeatures } from "../src/features";
import { resolveQemuBinary } from "../src/resolve";
import { resolveRuntimeEnv } from "../src/process";
import { makeFakePlatformPackage } from "./helpers";

const FEATURES = {
  guestTargets: ["x86_64", "aarch64"],
  accelerators: ["tcg", "kvm"],
  networking: { slirp: true },
  display: { gtk: false, sdl: false },
};

test("getQemuFeatures reads the build-info features block", () => {
  const pkg = makeFakePlatformPackage(
    "linux-x64",
    ["qemu-system-x86_64", "qemu-system-aarch64", "qemu-img"],
    { buildInfoExtra: { features: FEATURES } }
  );
  const features = getQemuFeatures({
    platform: "linux-x64",
    searchPaths: [pkg.searchPath],
  });
  assert.equal(features.source, "build-info");
  assert.deepEqual(features.guestTargets, ["x86_64", "aarch64"]);
  assert.deepEqual(features.accelerators, ["tcg", "kvm"]);
  assert.equal(features.networking.slirp, true);
  assert.equal(features.qemuVersion, "10.0.2");
});

test("getQemuFeatures falls back to assumptions without a features block", () => {
  const pkg = makeFakePlatformPackage(
    "linux-x64",
    ["qemu-system-x86_64", "qemu-img"]
  );
  const features = getQemuFeatures({
    platform: "linux-x64",
    searchPaths: [pkg.searchPath],
  });
  assert.equal(features.source, "assumed");
  assert.deepEqual(features.guestTargets, ["x86_64"]);
  assert.ok(features.accelerators.includes("tcg"));
  assert.ok(features.accelerators.includes("kvm"));
});

test("checkHostSupport reports ok for an installed package", () => {
  const pkg = makeFakePlatformPackage("linux-x64", ["qemu-img"]);
  const report = checkHostSupport({
    platform: "linux-x64",
    searchPaths: [pkg.searchPath],
  });
  assert.equal(report.ok, true);
  assert.equal(report.platform, "linux-x64");
  assert.equal(report.packageName, "qemu-portable-linux-x64");
  assert.deepEqual(report.availableCommands, ["qemu-img"]);
});

test("checkHostSupport never throws when the package is missing", () => {
  const report = checkHostSupport({
    platform: "linux-arm64",
    searchPaths: ["/nonexistent-search-path"],
  });
  assert.equal(report.ok, false);
  assert.equal(report.packageInstalled, false);
  assert.match(report.reason ?? "", /not installed/);
});

test("checkHostSupport flags an installed-but-empty (placeholder) package", () => {
  const pkg = makeFakePlatformPackage("linux-x64", []);
  const report = checkHostSupport({
    platform: "linux-x64",
    searchPaths: [pkg.searchPath],
  });
  assert.equal(report.ok, false);
  assert.equal(report.packageInstalled, true);
  assert.match(report.reason ?? "", /placeholder/);
});

test("resolveQemuBinary exposes firmwareDir alongside deprecated qemuDataDir", () => {
  const pkg = makeFakePlatformPackage("linux-x64", ["qemu-system-x86_64"]);
  const resolved = resolveQemuBinary("qemu-system-x86_64", {
    platform: "linux-x64",
    searchPaths: [pkg.searchPath],
  });
  assert.equal(resolved.firmwareDir, join(pkg.packageRoot, "share", "qemu"));
  assert.equal(resolved.firmwareDir, resolved.qemuDataDir);
});

test("resolveRuntimeEnv returns env additions as data (linux)", () => {
  const pkg = makeFakePlatformPackage("linux-x64", ["qemu-system-x86_64"]);
  // lib/ must exist for the addition to be emitted
  mkdirSync(join(pkg.packageRoot, "lib"), { recursive: true });
  const resolved = resolveQemuBinary("qemu-system-x86_64", {
    platform: "linux-x64",
    searchPaths: [pkg.searchPath],
  });
  const additions = resolveRuntimeEnv(resolved);
  assert.equal(additions.length, 1);
  assert.equal(additions[0].name, "LD_LIBRARY_PATH");
  assert.ok(additions[0].value.endsWith("lib"));
});

test("resolveRuntimeEnv returns PATH addition on win32", () => {
  const pkg = makeFakePlatformPackage("win32-x64", ["qemu-img"]);
  const resolved = resolveQemuBinary("qemu-img", {
    platform: "win32-x64",
    searchPaths: [pkg.searchPath],
  });
  const additions = resolveRuntimeEnv(resolved);
  assert.equal(additions.length, 1);
  assert.equal(additions[0].name, "PATH");
  assert.ok(additions[0].value.endsWith("bin"));
});
