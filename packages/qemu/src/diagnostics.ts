import { accessSync, constants } from "node:fs";

import {
  AccelerationMode,
  HostPlatform,
  PLATFORM_PACKAGES,
  getHostPlatform,
} from "./platform";
import { QemuFeatureFlags, getQemuFeatures } from "./features";
import {
  ResolvedQemuBinary,
  listAvailableBinaries,
  locatePlatformPackage,
} from "./resolve";

export interface AcceleratorHint {
  accelerator: AccelerationMode;
  available: boolean;
  reason?: string;
}

export interface QemuDiagnostics {
  hostPlatform: HostPlatform;
  nodeVersion: string;
  installedBinaryPackages: string[];
  missingBinaryPackages: string[];
  binaries: ResolvedQemuBinary[];
  acceleratorHints: AcceleratorHint[];
  /** Build feature flags of the installed platform package, if any. */
  features?: QemuFeatureFlags;
}

/**
 * Best-effort accelerator availability hints. These are hints, not
 * guarantees — QEMU itself is the authority, which is why the VM builder
 * emits `-accel <host>, -accel tcg` fallback chains instead of trusting this.
 */
export function getAcceleratorHints(
  platform: NodeJS.Platform = process.platform
): AcceleratorHint[] {
  const hints: AcceleratorHint[] = [];

  if (platform === "linux") {
    let kvm = false;
    let reason: string | undefined;
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
      kvm = true;
    } catch (err) {
      reason = `/dev/kvm not accessible (${(err as NodeJS.ErrnoException).code}). ` +
        `KVM may be disabled, or the user may lack kvm group membership.`;
    }
    hints.push({ accelerator: "kvm", available: kvm, reason });
    hints.push({ accelerator: "hvf", available: false, reason: "hvf is macOS-only" });
    hints.push({ accelerator: "whpx", available: false, reason: "whpx is Windows-only" });
  } else if (platform === "darwin") {
    hints.push({
      accelerator: "hvf",
      available: true,
      reason:
        "Hypervisor.framework is present on supported macOS versions; QEMU " +
        "falls back to tcg if initialization fails.",
    });
    hints.push({ accelerator: "kvm", available: false, reason: "kvm is Linux-only" });
    hints.push({ accelerator: "whpx", available: false, reason: "whpx is Windows-only" });
  } else if (platform === "win32") {
    hints.push({
      accelerator: "whpx",
      available: true,
      reason:
        "Assumes the Windows Hypervisor Platform feature is enabled; QEMU " +
        "falls back to tcg if initialization fails.",
    });
    hints.push({ accelerator: "kvm", available: false, reason: "kvm is Linux-only" });
    hints.push({ accelerator: "hvf", available: false, reason: "hvf is macOS-only" });
  }

  hints.push({
    accelerator: "tcg",
    available: true,
    reason: "Software emulation is always available (slower).",
  });
  return hints;
}

/**
 * Collects a user-facing diagnostics report suitable for pasting into bug
 * reports: host platform, installed/missing binary packages, resolved
 * binaries, and accelerator hints.
 */
export async function getQemuDiagnostics(options: {
  platform?: HostPlatform;
  searchPaths?: string[];
} = {}): Promise<QemuDiagnostics> {
  const hostPlatform = options.platform ?? getHostPlatform();

  const installedBinaryPackages: string[] = [];
  const missingBinaryPackages: string[] = [];
  for (const pkg of Object.values(PLATFORM_PACKAGES)) {
    if (locatePlatformPackage(pkg, options.searchPaths)) {
      installedBinaryPackages.push(pkg);
    } else {
      missingBinaryPackages.push(pkg);
    }
  }

  const binaries = listAvailableBinaries({
    platform: hostPlatform,
    searchPaths: options.searchPaths,
  });

  let features: QemuFeatureFlags | undefined;
  if (binaries.length > 0) {
    features = getQemuFeatures({
      platform: hostPlatform,
      searchPaths: options.searchPaths,
    });
  }

  return {
    hostPlatform,
    nodeVersion: process.version,
    installedBinaryPackages,
    missingBinaryPackages,
    binaries,
    acceleratorHints: getAcceleratorHints(),
    features,
  };
}

/** Renders a diagnostics report as human-readable text (used by the CLI). */
export function formatDiagnostics(diag: QemuDiagnostics): string {
  const lines: string[] = [];
  lines.push(`Host platform:        ${diag.hostPlatform}`);
  lines.push(`Node.js version:      ${diag.nodeVersion}`);
  lines.push("");
  lines.push("Installed binary packages:");
  if (diag.installedBinaryPackages.length === 0) {
    lines.push("  (none — optional dependencies may have been omitted)");
  }
  for (const pkg of diag.installedBinaryPackages) lines.push(`  ${pkg}`);
  lines.push("");
  lines.push("Missing binary packages (expected on other platforms):");
  for (const pkg of diag.missingBinaryPackages) lines.push(`  ${pkg}`);
  lines.push("");
  lines.push("Resolved binaries:");
  if (diag.binaries.length === 0) lines.push("  (none)");
  for (const bin of diag.binaries) {
    lines.push(`  ${bin.command}`);
    lines.push(`    path:     ${bin.path}`);
    lines.push(`    package:  ${bin.packageName}`);
    if (bin.version) lines.push(`    version:  ${bin.version}`);
    if (bin.qemuDataDir) lines.push(`    data dir: ${bin.qemuDataDir}`);
  }
  if (diag.features) {
    lines.push("");
    lines.push(`Build features (${diag.features.source}):`);
    lines.push(`  guest targets: ${diag.features.guestTargets.join(", ") || "(none)"}`);
    lines.push(`  accelerators:  ${diag.features.accelerators.join(", ")}`);
    lines.push(`  slirp:         ${diag.features.networking.slirp}`);
  }
  lines.push("");
  lines.push("Accelerator hints:");
  for (const hint of diag.acceleratorHints) {
    lines.push(
      `  ${hint.accelerator.padEnd(5)} ${hint.available ? "available" : "unavailable"}` +
        (hint.reason ? ` — ${hint.reason}` : "")
    );
  }
  return lines.join("\n");
}
