import assert from "node:assert/strict";
import test from "node:test";

import { QemuCommandError, QemuTimeoutError } from "../src/errors";
import { HostPlatform } from "../src/platform";
import { execQemu, execQemuOrThrow, spawnQemu } from "../src/process";
import { parseQemuVersionOutput, getQemuVersion } from "../src/version";
import { makeFakePlatformPackage } from "./helpers";

const POSIX = process.platform !== "win32";

function hostPlatformForTests(): HostPlatform {
  return process.platform === "darwin"
    ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
    : (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
}

test("parseQemuVersionOutput handles emulator and qemu-img formats", () => {
  assert.equal(
    parseQemuVersionOutput("QEMU emulator version 10.0.2 (v10.0.2)"),
    "10.0.2"
  );
  assert.equal(parseQemuVersionOutput("qemu-img version 9.2.0"), "9.2.0");
  assert.equal(
    parseQemuVersionOutput("QEMU emulator version 10.0.50-rc1"),
    "10.0.50-rc1"
  );
  assert.equal(parseQemuVersionOutput("garbage"), undefined);
});

test("execQemu captures stdout/stderr and exit code", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: '#!/bin/sh\necho out-line\necho err-line >&2\nexit 3\n',
  });
  const result = await execQemu("qemu-img", [], {
    resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
  });
  assert.equal(result.code, 3);
  assert.equal(result.stdout?.toString("utf8").trim(), "out-line");
  assert.equal(result.stderr?.toString("utf8").trim(), "err-line");
});

test("execQemuOrThrow raises QemuCommandError with stderr in message", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: '#!/bin/sh\necho "something broke" >&2\nexit 1\n',
  });
  await assert.rejects(
    execQemuOrThrow("qemu-img", ["info", "x"], {
      resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
    }),
    (err: Error) => {
      assert.ok(err instanceof QemuCommandError);
      assert.equal(err.code, "ERR_QEMU_COMMAND_FAILED");
      assert.match(err.message, /something broke/);
      assert.equal(err.result.code, 1);
      return true;
    }
  );
});

test("timeoutMs kills long-running commands with QemuTimeoutError", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: "#!/bin/sh\nexec sleep 30\n",
  });
  const proc = spawnQemu("qemu-img", [], {
    timeoutMs: 200,
    resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
  });
  await assert.rejects(proc.wait(), QemuTimeoutError);
});

test("spawnQemu injects -L for system emulators but not for tools", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(
    hostPlatformForTests(),
    ["qemu-system-x86_64", "qemu-img"],
    { script: '#!/bin/sh\necho "$@"\n' }
  );
  const resolve = { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] };

  const system = await execQemu("qemu-system-x86_64", ["-machine", "help"], { resolve });
  assert.match(system.stdout!.toString("utf8"), /^-L .*share\/qemu -machine help/);

  const tool = await execQemu("qemu-img", ["--version"], { resolve });
  assert.doesNotMatch(tool.stdout!.toString("utf8"), /-L /);
});

test("caller-supplied -L suppresses auto-injection", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-system-x86_64"], {
    script: '#!/bin/sh\necho "$@"\n',
  });
  const result = await execQemu(
    "qemu-system-x86_64",
    ["-L", "/custom/data", "-machine", "help"],
    { resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] } }
  );
  const echoed = result.stdout!.toString("utf8").trim();
  assert.equal(echoed, "-L /custom/data -machine help");
});

test("getQemuVersion runs --version against the vendored binary", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: '#!/bin/sh\necho "qemu-img version 10.0.2"\n',
  });
  const info = await getQemuVersion("qemu-img", {
    resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
  });
  assert.equal(info.qemuVersion, "10.0.2");
  assert.equal(info.command, "qemu-img");
  assert.match(info.rawOutput, /qemu-img version/);
});

test("AbortSignal terminates the process", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: "#!/bin/sh\nexec sleep 30\n",
  });
  const controller = new AbortController();
  const proc = spawnQemu("qemu-img", [], {
    signal: controller.signal,
    resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
  });
  setTimeout(() => controller.abort(), 100);
  const result = await proc.wait().catch(() => null);
  // Node surfaces abort as an 'error' event; either path must not hang.
  assert.ok(result === null || result.signal !== null);
});
