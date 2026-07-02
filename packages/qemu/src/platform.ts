import { existsSync, readdirSync } from "node:fs";
import { UnsupportedPlatformError } from "./errors";

/** Host platform: the machine running Node.js and QEMU. */
export type HostPlatform =
  | "linux-x64"
  | "linux-arm64"
  | "linux-x64-musl"
  | "linux-arm64-musl"
  | "darwin-arm64"
  | "darwin-x64"
  | "win32-x64";

/** Guest target: the architecture QEMU emulates or virtualizes. */
export type GuestTarget = "x86_64" | "aarch64" | "riscv64";

export type QemuSystemCommand =
  | "qemu-system-x86_64"
  | "qemu-system-aarch64"
  | "qemu-system-riscv64";

export type QemuToolCommand = "qemu-img";

export type QemuCommand = QemuSystemCommand | QemuToolCommand;

export type AccelerationMode = "auto" | "tcg" | "kvm" | "hvf" | "whpx";

export type Libc = "glibc" | "musl";

/** Commands every MVP platform package is expected to ship. */
export const MVP_COMMANDS: QemuCommand[] = [
  "qemu-system-x86_64",
  "qemu-system-aarch64",
  "qemu-img",
];

/** Maps a host platform to the npm package that vendors its binaries. */
export const PLATFORM_PACKAGES: Record<HostPlatform, string> = {
  "linux-x64": "@org/qemu-linux-x64",
  "linux-arm64": "@org/qemu-linux-arm64",
  "linux-x64-musl": "@org/qemu-linux-x64-musl",
  "linux-arm64-musl": "@org/qemu-linux-arm64-musl",
  "darwin-arm64": "@org/qemu-darwin-arm64",
  "darwin-x64": "@org/qemu-darwin-x64",
  "win32-x64": "@org/qemu-win32-x64",
};

export const SUPPORTED_PLATFORMS = Object.keys(
  PLATFORM_PACKAGES
) as HostPlatform[];

/**
 * Detects the C library flavor on Linux. Returns "glibc" on non-Linux hosts
 * (the distinction only matters for Linux package selection).
 */
export function detectLibc(): Libc {
  if (process.platform !== "linux") return "glibc";

  // Node exposes the glibc runtime version in the process report header when
  // running against glibc; it is absent on musl.
  try {
    const report = (process as NodeJS.Process & {
      report?: { getReport(): unknown };
    }).report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    if (report?.header?.glibcVersionRuntime) return "glibc";
  } catch {
    // fall through to filesystem probing
  }

  try {
    if (
      existsSync("/lib") &&
      readdirSync("/lib").some((f) => f.startsWith("ld-musl-"))
    ) {
      return "musl";
    }
  } catch {
    // fall through
  }

  return "glibc";
}

export interface GetHostPlatformOptions {
  /** Override process.platform (for tests). */
  platform?: NodeJS.Platform;
  /** Override process.arch (for tests). */
  arch?: NodeJS.Architecture;
  /** Override libc detection (for tests). */
  libc?: Libc;
}

/**
 * Determines the host platform key used to select the vendored binary
 * package. Throws {@link UnsupportedPlatformError} for platforms the
 * project does not ship binaries for.
 */
export function getHostPlatform(
  options: GetHostPlatformOptions = {}
): HostPlatform {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (platform === "linux") {
    const libc = options.libc ?? detectLibc();
    if (arch === "x64") return libc === "musl" ? "linux-x64-musl" : "linux-x64";
    if (arch === "arm64")
      return libc === "musl" ? "linux-arm64-musl" : "linux-arm64";
  }
  if (platform === "darwin") {
    if (arch === "arm64") return "darwin-arm64";
    if (arch === "x64") return "darwin-x64";
  }
  if (platform === "win32" && arch === "x64") return "win32-x64";

  throw new UnsupportedPlatformError(
    `Unsupported host platform: ${platform}-${arch}.\n` +
      `Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}.\n` +
      `QEMU must run as a native child process, so @org/qemu only works ` +
      `where a vendored binary package exists.`
  );
}

/** True when the platform uses Windows executable naming. */
export function isWindowsPlatform(platform: HostPlatform): boolean {
  return platform.startsWith("win32");
}

/** Executable file name for a command on a platform (adds .exe on Windows). */
export function executableName(
  command: QemuCommand,
  platform: HostPlatform
): string {
  return isWindowsPlatform(platform) ? `${command}.exe` : command;
}
