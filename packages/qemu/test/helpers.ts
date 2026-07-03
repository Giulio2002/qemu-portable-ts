import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostPlatform, QemuCommandName } from "../src/platform";
import { PLATFORM_PACKAGES, executableName } from "../src/platform";

export interface FakePackageTree {
  /** Directory to pass as searchPaths[0] to the resolver. */
  searchPath: string;
  packageRoot: string;
  packageName: string;
}

/**
 * Builds a fake platform binary package under a temp node_modules so
 * resolver tests run without any real QEMU binaries installed.
 */
export function makeFakePlatformPackage(
  platform: HostPlatform,
  commands: QemuCommandName[],
  options: {
    withDataDir?: boolean;
    withBuildInfo?: boolean;
    /** Shell script body for each fake binary (POSIX platforms). */
    script?: string;
  } = {}
): FakePackageTree {
  // realpath so paths match require.resolve output (macOS /var symlink).
  const searchPath = realpathSync(mkdtempSync(join(tmpdir(), "qemu-ts-test-")));
  const packageName = PLATFORM_PACKAGES[platform];
  const packageRoot = join(searchPath, "node_modules", ...packageName.split("/"));
  const binDir = join(packageRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version: "0.0.0-test" })
  );

  for (const command of commands) {
    const exe = join(binDir, executableName(command, platform));
    const body =
      options.script ??
      `#!/bin/sh\necho "QEMU emulator version 10.0.2 (fake)"\n`;
    writeFileSync(exe, body);
    chmodSync(exe, 0o755);
  }

  if (options.withDataDir ?? true) {
    const dataDir = join(packageRoot, "share", "qemu");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "keymaps-placeholder"), "");
  }

  if (options.withBuildInfo ?? true) {
    writeFileSync(
      join(packageRoot, "build-info.json"),
      JSON.stringify({
        qemuVersion: "10.0.2",
        qemuGitRef: "v10.0.2",
        buildHost: "test",
        builtAt: "2026-07-02T00:00:00.000Z",
        targets: commands,
        configureArgs: ["--target-list=x86_64-softmmu,aarch64-softmmu"],
        runtimeDependencies: [],
      })
    );
  }

  return { searchPath, packageRoot, packageName };
}
