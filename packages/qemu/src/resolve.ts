import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { QemuBinaryNotFoundError } from "./errors";
import {
  HostPlatform,
  MVP_COMMANDS,
  PLATFORM_PACKAGES,
  QemuCommand,
  executableName,
  getHostPlatform,
  isWindowsPlatform,
} from "./platform";

export interface QemuBuildInfo {
  qemuVersion: string;
  qemuGitRef: string;
  buildHost: string;
  builtAt: string;
  targets: QemuCommand[];
  configureArgs: string[];
  runtimeDependencies: string[];
  sourceArchiveSha256?: string;
  patches?: string[];
}

export interface ResolvedQemuBinary {
  command: QemuCommand;
  path: string;
  packageName: string;
  packageRoot: string;
  hostPlatform: HostPlatform;
  qemuDataDir?: string;
  version?: string;
  buildInfo?: QemuBuildInfo;
}

export interface ResolveQemuOptions {
  /** Resolve for a specific platform instead of auto-detecting the host. */
  platform?: HostPlatform;
  /** Prefer a QEMU binary found on PATH over the vendored one. Off by default. */
  preferSystem?: boolean;
  /** Environment used for PATH lookup when preferSystem is set. */
  env?: NodeJS.ProcessEnv;
  /**
   * Extra directories to search for the platform package (passed to
   * require.resolve paths). Primarily for tests; normal consumers rely on
   * standard node_modules resolution relative to this package.
   */
  searchPaths?: string[];
}

/**
 * Locates the root directory of an installed platform binary package.
 * Returns undefined when the package is not installed (e.g. optional
 * dependencies were omitted, or we are asked about a foreign platform).
 */
export function locatePlatformPackage(
  packageName: string,
  searchPaths?: string[]
): string | undefined {
  try {
    const resolved = require.resolve(`${packageName}/package.json`, {
      paths: searchPaths && searchPaths.length > 0 ? searchPaths : [__dirname],
    });
    return dirname(resolved);
  } catch {
    return undefined;
  }
}

function missingPackageMessage(
  platform: HostPlatform,
  packageName: string
): string {
  return (
    `No vendored QEMU binary package found for ${platform}.\n\n` +
    `Expected optional dependency:\n` +
    `  ${packageName}\n\n` +
    `This usually means optional dependencies were skipped, for example:\n` +
    `  npm install --omit=optional\n` +
    `  pnpm install --no-optional\n\n` +
    `Reinstall without omitting optional dependencies.`
  );
}

function missingBinaryMessage(
  command: QemuCommand,
  packageName: string,
  binaryPath: string
): string {
  return (
    `The vendored binary package ${packageName} is installed but does not ` +
    `contain "${command}".\n\n` +
    `Expected binary path:\n  ${binaryPath}\n\n` +
    `This build of the platform package may not include that guest target. ` +
    `Run "qemu-ts diagnostics" to list the binaries that are available.`
  );
}

function readBuildInfo(packageRoot: string): QemuBuildInfo | undefined {
  const buildInfoPath = join(packageRoot, "build-info.json");
  if (!existsSync(buildInfoPath)) return undefined;
  try {
    return JSON.parse(readFileSync(buildInfoPath, "utf8")) as QemuBuildInfo;
  } catch {
    return undefined;
  }
}

function findOnPath(
  exe: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not there; keep looking
    }
  }
  return undefined;
}

/**
 * Resolves the filesystem path of a QEMU command.
 *
 * Default behavior: use the vendored binary from the platform package and
 * never consult PATH. Set `preferSystem: true` to check PATH first.
 */
export function resolveQemuBinary(
  command: QemuCommand,
  options: Omit<ResolveQemuOptions, "command"> = {}
): ResolvedQemuBinary {
  const platform = options.platform ?? getHostPlatform();
  const packageName = PLATFORM_PACKAGES[platform];
  const exe = executableName(command, platform);

  if (options.preferSystem) {
    const systemPath = findOnPath(exe, options.env ?? process.env);
    if (systemPath) {
      return {
        command,
        path: systemPath,
        packageName: "(system PATH)",
        packageRoot: dirname(systemPath),
        hostPlatform: platform,
      };
    }
  }

  const packageRoot = locatePlatformPackage(packageName, options.searchPaths);
  if (!packageRoot) {
    throw new QemuBinaryNotFoundError(
      missingPackageMessage(platform, packageName)
    );
  }

  const binaryPath = join(packageRoot, "bin", exe);
  if (!existsSync(binaryPath)) {
    throw new QemuBinaryNotFoundError(
      missingBinaryMessage(command, packageName, binaryPath)
    );
  }

  const dataDir = join(packageRoot, "share", "qemu");
  const buildInfo = readBuildInfo(packageRoot);

  return {
    command,
    path: binaryPath,
    packageName,
    packageRoot,
    hostPlatform: platform,
    qemuDataDir: existsSync(dataDir) ? dataDir : undefined,
    version: buildInfo?.qemuVersion,
    buildInfo,
  };
}

/**
 * Lists every QEMU binary the installed platform package provides for the
 * current (or overridden) host platform. Returns an empty array when no
 * platform package is installed.
 */
export function listAvailableBinaries(
  options: Omit<ResolveQemuOptions, "command"> = {}
): ResolvedQemuBinary[] {
  let platform: HostPlatform;
  try {
    platform = options.platform ?? getHostPlatform();
  } catch {
    return [];
  }
  const packageName = PLATFORM_PACKAGES[platform];
  const packageRoot = locatePlatformPackage(packageName, options.searchPaths);
  if (!packageRoot) return [];

  const binDir = join(packageRoot, "bin");
  if (!existsSync(binDir)) return [];

  const suffix = isWindowsPlatform(platform) ? ".exe" : "";
  const known = new Set<string>(
    [...MVP_COMMANDS, "qemu-system-riscv64"].map((c) => `${c}${suffix}`)
  );

  const results: ResolvedQemuBinary[] = [];
  for (const entry of readdirSync(binDir)) {
    if (!known.has(entry)) continue;
    const command = (suffix ? entry.slice(0, -suffix.length) : entry) as QemuCommand;
    results.push(resolveQemuBinary(command, { ...options, platform }));
  }
  return results;
}
