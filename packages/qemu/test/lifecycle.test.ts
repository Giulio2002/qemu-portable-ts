import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HostPlatform } from "../src/platform";
import {
  countLiveQemuProcesses,
  killAllQemuProcesses,
  spawnQemu,
} from "../src/process";
import { makeFakePlatformPackage } from "./helpers";

const POSIX = process.platform !== "win32";

function hostPlatformForTests(): HostPlatform {
  return process.platform === "darwin"
    ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
    : (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("live children are tracked and removed on close", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: "#!/bin/sh\nexec sleep 30\n",
  });
  const before = countLiveQemuProcesses();
  const proc = spawnQemu("qemu-img", [], {
    resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
  });
  assert.equal(countLiveQemuProcesses(), before + 1);
  proc.kill("SIGKILL");
  await proc.wait();
  assert.equal(countLiveQemuProcesses(), before);
});

test("killOnExit: false opts a child out of tracking", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: "#!/bin/sh\nexec sleep 30\n",
  });
  const before = countLiveQemuProcesses();
  const proc = spawnQemu("qemu-img", [], {
    resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
    killOnExit: false,
  });
  assert.equal(countLiveQemuProcesses(), before);
  proc.kill("SIGKILL");
  await proc.wait();
});

test("killAllQemuProcesses kills tracked children", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: "#!/bin/sh\nexec sleep 30\n",
  });
  const proc = spawnQemu("qemu-img", [], {
    resolve: { platform: hostPlatformForTests(), searchPaths: [fake.searchPath] },
  });
  assert.ok(proc.pid && pidAlive(proc.pid));
  killAllQemuProcesses("SIGKILL");
  await proc.wait();
  assert.ok(!pidAlive(proc.pid as number));
});

test("QEMU children die when the parent process exits", { skip: !POSIX }, async () => {
  const fake = makeFakePlatformPackage(hostPlatformForTests(), ["qemu-img"], {
    script: "#!/bin/sh\nexec sleep 30\n",
  });
  const dir = mkdtempSync(join(tmpdir(), "qemu-orphan-"));
  const pidFile = join(dir, "child.pid");
  try {
    const fixture = join(__dirname, "orphan-fixture.js");
    const result = spawnSync(
      process.execPath,
      [fixture, hostPlatformForTests(), fake.searchPath, pidFile],
      { encoding: "utf8", timeout: 15_000 }
    );
    assert.equal(result.status, 0, `fixture failed: ${result.stderr}`);

    const childPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    // The exit hook sends SIGKILL synchronously on parent exit; give the OS
    // a moment to reap.
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      alive = pidAlive(childPid);
      if (alive) await sleep(100);
    }
    assert.ok(!alive, `fake QEMU (pid ${childPid}) survived parent exit`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
