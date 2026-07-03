import {
  AccelerationMode,
  GuestTarget,
  HostPlatform,
  PLATFORM_PACKAGES,
  getHostPlatform,
} from "./platform";
import {
  QemuBuildInfo,
  ResolveQemuOptions,
  isPlaceholderPackage,
  listAvailableBinaries,
  locatePlatformPackage,
} from "./resolve";

/**
 * What a vendored QEMU build supports — compiled-in capabilities, not host
 * availability. A build can have `kvm` in {@link QemuFeatureFlags.accelerators}
 * while /dev/kvm is absent; combine with `getAcceleratorHints()` (or just let
 * the `-accel <host>, -accel tcg` fallback chain decide) for runtime checks.
 */
export interface QemuFeatureFlags {
  /** Guest architectures with a qemu-system-* emulator in the package. */
  guestTargets: (GuestTarget | (string & {}))[];
  /** Accelerators compiled into the build (tcg is always present). */
  accelerators: AccelerationMode[];
  networking: { slirp: boolean };
  display: { gtk: boolean; sdl: boolean };
  /**
   * "build-info": read from the package's build-time record (authoritative).
   * "assumed": no build-time record (e.g. a local dev fill); derived from the
   * installed binaries and platform defaults.
   */
  source: "build-info" | "assumed";
  qemuVersion?: string;
}

/** Platform-default accelerator set used when no build record exists. */
function assumedAccelerators(platform: HostPlatform): AccelerationMode[] {
  if (platform.startsWith("linux")) return ["tcg", "kvm"];
  if (platform.startsWith("darwin")) return ["tcg", "hvf"];
  return ["tcg", "whpx"];
}

/**
 * Reports the feature flags of the installed platform package.
 *
 * Reads the `features` block that scripts/generate-build-info.ts derives at
 * build time from the actual configure arguments. Falls back to inspecting
 * the shipped binaries plus platform defaults when the package carries no
 * build record (`source: "assumed"`).
 *
 * Throws {@link QemuBinaryNotFoundError} when no platform package is
 * installed — use {@link checkHostSupport} first for a non-throwing preflight.
 */
export function getQemuFeatures(
  options: Omit<ResolveQemuOptions, "command"> = {}
): QemuFeatureFlags {
  const binaries = listAvailableBinaries(options);
  const buildInfo = binaries.find((b) => b.buildInfo)?.buildInfo as
    | (QemuBuildInfo & { features?: Omit<QemuFeatureFlags, "source" | "qemuVersion"> })
    | undefined;

  if (buildInfo?.features) {
    return {
      ...buildInfo.features,
      source: "build-info",
      qemuVersion: buildInfo.qemuVersion,
    };
  }

  const platform = options.platform ?? getHostPlatform();
  return {
    guestTargets: binaries
      .filter((b) => String(b.command).startsWith("qemu-system-"))
      .map((b) => String(b.command).replace("qemu-system-", "")),
    accelerators: assumedAccelerators(platform),
    networking: { slirp: true },
    display: { gtk: false, sdl: false },
    source: "assumed",
    qemuVersion: buildInfo?.qemuVersion,
  };
}

/**
 * Non-throwing preflight for "can this host run vendored QEMU?".
 * Every failure mode is data, never an exception, so it is safe to call in
 * feature-detection paths (CLI startup, install checks, UI gating).
 */
export interface HostSupportReport {
  /** True when the host platform is supported AND its package is installed. */
  ok: boolean;
  /** Detected host platform key, if the platform is supported at all. */
  platform?: HostPlatform;
  /** The npm package expected to carry this host's binaries. */
  packageName?: string;
  /** True when that package is installed (placeholders don't count). */
  packageInstalled: boolean;
  /** Commands the installed package actually ships. */
  availableCommands: string[];
  /** Human-readable explanation when ok is false. */
  reason?: string;
}

export function checkHostSupport(
  options: Omit<ResolveQemuOptions, "command"> = {}
): HostSupportReport {
  let platform: HostPlatform;
  try {
    platform = options.platform ?? getHostPlatform();
  } catch (err) {
    return {
      ok: false,
      packageInstalled: false,
      availableCommands: [],
      reason: (err as Error).message,
    };
  }

  const packageName = PLATFORM_PACKAGES[platform];
  const packageRoot = locatePlatformPackage(packageName, options.searchPaths);
  if (!packageRoot) {
    return {
      ok: false,
      platform,
      packageName,
      packageInstalled: false,
      availableCommands: [],
      reason:
        `${packageName} is not installed (optional dependencies may have ` +
        `been omitted at install time).`,
    };
  }

  const binaries = listAvailableBinaries({ ...options, platform });
  if (binaries.length === 0) {
    return {
      ok: false,
      platform,
      packageName,
      packageInstalled: true,
      availableCommands: [],
      reason: isPlaceholderPackage(packageRoot)
        ? `${packageName} is a registry placeholder — no QEMU binaries have ` +
          `been published for ${platform} yet.`
        : `${packageName} is installed but contains no binaries — it may be a ` +
          `placeholder published for a platform without builds yet.`,
    };
  }

  return {
    ok: true,
    platform,
    packageName,
    packageInstalled: true,
    availableCommands: binaries.map((b) => String(b.command)),
  };
}
