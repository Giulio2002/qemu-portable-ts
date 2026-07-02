import assert from "node:assert/strict";
import test from "node:test";

import { QemuSystemCommand } from "../src/platform";
import { ResolvedQemuBinary } from "../src/resolve";
import { buildVmArgs, createVm } from "../src/vm";
import { makeFakePlatformPackage } from "./helpers";

function fakeResolved(command: QemuSystemCommand): ResolvedQemuBinary {
  return {
    command,
    path: `/fake/bin/${command}`,
    packageName: "@org/qemu-test",
    packageRoot: "/fake",
    hostPlatform: "linux-x64",
    qemuDataDir: "/fake/share/qemu",
  };
}

test("buildVmArgs resolves the right system command for the target", () => {
  const built = buildVmArgs(
    { target: "aarch64", memory: "1G" },
    { resolveBinary: fakeResolved }
  );
  assert.equal(built.command, "qemu-system-aarch64");
  assert.equal(built.resolved.path, "/fake/bin/qemu-system-aarch64");
  assert.ok(built.args.includes("-m"));
});

test("createVm().build() exposes auditable args without starting anything", () => {
  const vm = createVm(
    {
      target: "x86_64",
      machine: "q35",
      memory: "512M",
      acceleration: "tcg",
      extraArgs: ["-machine", "help"],
    },
    { resolveBinary: fakeResolved }
  );
  const built = vm.build();
  assert.equal(built.command, "qemu-system-x86_64");
  assert.deepEqual(built.args.slice(-2), ["-machine", "help"]);
  // -L is injected by the process layer at start(), not by build().
  assert.equal(built.args.indexOf("-L"), -1);
});

test("vm.start() runs the resolved binary and injects -L <share/qemu>", async () => {
  if (process.platform === "win32") return; // fake binaries are shell scripts

  const hostPlatform = process.platform === "darwin"
    ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
    : (process.arch === "arm64" ? "linux-arm64" : "linux-x64");

  // Fake qemu-system that just echoes its argv.
  const fake = makeFakePlatformPackage(
    hostPlatform,
    ["qemu-system-x86_64"],
    { script: '#!/bin/sh\necho "$@"\n' }
  );

  const vm = createVm(
    { target: "x86_64", acceleration: "tcg", memory: "256M" },
    { resolve: { platform: hostPlatform, searchPaths: [fake.searchPath] } }
  );

  const proc = vm.start();
  const result = await proc.wait();
  assert.equal(result.code, 0);

  const echoed = (result.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  assert.ok(
    echoed.startsWith("-L "),
    `expected -L injection first, got: ${echoed}`
  );
  assert.ok(echoed.includes("share/qemu"));
  assert.ok(echoed.includes("-accel tcg"));
  assert.ok(echoed.includes("-m 256M"));
});
