import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

import { QemuBinaryNotFoundError, QemuInvalidCommandError } from "./errors";
import {
  HostPlatform,
  PLATFORM_PACKAGES,
  QemuCommandName,
  executableName,
  getHostPlatform,
  isWindowsPlatform,
} from "./platform";

export interface QemuBuildInfo {
  qemuVersion: string;
  qemuGitRef: string;
  buildHost: string;
  builtAt: string;
  targets: QemuCommandName[];
  configureArgs: string[];
  /** Build-time feature flags (see getQemuFeatures); absent in dev fills. */
  features?: {
    guestTargets: string[];
    accelerators: string[];
    networking: { slirp: boolean };
    display: { gtk: boolean; sdl: boolean };
  };
  runtimeDependencies: string[];
  sourceArchiveSha256?: string;
  patches?: string[];
}

export interface ResolvedQemuBinary {
  command: QemuCommandName;
  path: string;
  packageName: string;
  packageRoot: string;
  hostPlatform: HostPlatform;
  /**
   * Directory holding QEMU's firmware/keymap data (the package's
   * share/qemu). Pass it as `-L <firmwareDir>` when spawning the binary
   * yourself; the managed spawnQemu() path injects it automatically.
   * Undefined for binaries resolved from PATH or packages without data.
   */
  firmwareDir?: string;
  /** @deprecated Alias of {@link firmwareDir}; kept for compatibility. */
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
 * Ensures a command names a binary inside a package's bin/ directory rather
 * than a path that escapes it. This is not an allowlist — any name is fine —
 * it only rejects path separators, `..`, absolute paths, and NUL bytes so
 * `join(packageRoot, "bin", command)` cannot resolve outside bin/.
 */
export function assertContainedCommandName(command: string): void {
  if (
    command.length === 0 ||
    command === "." ||
    command === ".." ||
    command.includes("\0") ||
    command !== basename(command)
  ) {
    throw new QemuInvalidCommandError(
      `Invalid QEMU command name ${JSON.stringify(command)}.\n` +
        `The resolver only resolves a binary inside the platform package's ` +
        `bin/ directory, so the command must be a bare file name (no path ` +
        `separators, no "..", not absolute).\n` +
        `To run a binary by absolute path, spawn it yourself or pass ` +
        `preferSystem to use one from PATH.`
    );
  }
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
  command: QemuCommandName,
  packageName: string,
  binaryPath: string
): string {
  return (
    `The vendored binary package ${packageName} is installed but does not ` +
    `contain "${command}".\n\n` +
    `Expected binary path:\n  ${binaryPath}\n\n` +
    `This build of the platform package may not include that guest target. ` +
    `Run "qemu-portable diagnostics" to list the binaries that are available.`
  );
}

/**
 * True when an installed platform package is a registry placeholder (see
 * scripts/make-placeholder-package.ts): it resolves like the real package
 * but ships no binaries.
 */
export function isPlaceholderPackage(packageRoot: string): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8")
    ) as { qemuPortable?: { placeholder?: boolean } };
    return manifest.qemuPortable?.placeholder === true;
  } catch {
    return false;
  }
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
  command: QemuCommandName,
  options: Omit<ResolveQemuOptions, "command"> = {}
): ResolvedQemuBinary {
  // No allowlist: any command name is accepted. The only constraint is that
  // it names a binary *inside* the platform package's bin/ directory — a bare
  // file name with no path separators. This keeps the resolver's contract
  // (resolve a vendored binary) intact and stops "../../bin/sh" style traversal
  // from turning into arbitrary host-binary execution, without dictating which
  // QEMU commands you may run. To run a binary by absolute path, spawn it
  // yourself or use `preferSystem`.
  assertContainedCommandName(command);
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
    if (isPlaceholderPackage(packageRoot)) {
      throw new QemuBinaryNotFoundError(
        `${packageName} is installed but is a placeholder: no QEMU binaries ` +
          `have been published for ${platform} yet.\n` +
          `Check https://github.com/Giulio2002/qemu-portable-ts for platform status.`
      );
    }
    throw new QemuBinaryNotFoundError(
      missingBinaryMessage(command, packageName, binaryPath)
    );
  }

  const dataDir = join(packageRoot, "share", "qemu");
  const buildInfo = readBuildInfo(packageRoot);
  const firmwareDir = existsSync(dataDir) ? dataDir : undefined;

  return {
    command,
    path: binaryPath,
    packageName,
    packageRoot,
    hostPlatform: platform,
    firmwareDir,
    qemuDataDir: firmwareDir,
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

  // List every qemu-* binary the package actually ships, not a curated set —
  // qemu-io, qemu-nbd, extra qemu-system-* targets all show up if present.
  const isWindows = isWindowsPlatform(platform);
  const suffix = isWindows ? ".exe" : "";
  const results: ResolvedQemuBinary[] = [];
  for (const entry of readdirSync(binDir)) {
    if (!entry.startsWith("qemu-")) continue;
    if (isWindows) {
      if (!entry.endsWith(".exe")) continue; // skip bundled .dll files
    } else if (entry.includes(".")) {
      continue; // skip non-executable artifacts on POSIX
    }
    const command = suffix && entry.endsWith(suffix)
      ? entry.slice(0, -suffix.length)
      : entry;
    results.push(resolveQemuBinary(command, { ...options, platform }));
  }
  return results;
}
