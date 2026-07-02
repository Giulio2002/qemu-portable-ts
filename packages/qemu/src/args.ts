import { InvalidVmConfigError } from "./errors";
import {
  AccelerationMode,
  GuestTarget,
  QemuSystemCommand,
} from "./platform";
import type { DiskImageFormat } from "./qemu-img";

export interface DiskConfig {
  path: string;
  format?: DiskImageFormat;
  interface?: "virtio" | "ide" | "scsi";
  readonly?: boolean;
  snapshot?: boolean;
}

export interface KernelBootConfig {
  kernel: string;
  initrd?: string;
  append?: string;
}

export interface HostForward {
  protocol: "tcp" | "udp";
  hostPort: number;
  guestPort: number;
  hostAddress?: string;
  guestAddress?: string;
}

export interface NetworkConfig {
  type: "none" | "user";
  hostForwards?: HostForward[];
}

export interface QmpConfig {
  enabled: boolean;
  /** Unix socket path (Linux/macOS) or 127.0.0.1 TCP port via "tcp:PORT" (Windows). */
  socketPath?: string;
  server?: boolean;
  wait?: boolean;
}

export interface VmConfig {
  target: GuestTarget;
  name?: string;
  machine?: string;
  cpu?: string;
  /** e.g. "2G", "512M", or a number of mebibytes. */
  memory?: string | number;
  smp?: number;
  acceleration?: AccelerationMode;
  display?: "none" | "gtk" | "sdl" | "cocoa";
  serial?: "stdio" | "none" | { file: string };
  qmp?: QmpConfig;
  disks?: DiskConfig[];
  cdrom?: string;
  kernel?: KernelBootConfig;
  network?: NetworkConfig;
  extraArgs?: string[];
}

/** QEMU option values escape "," by doubling it. */
export function escapeQemuOptionValue(value: string): string {
  return value.replace(/,/g, ",,");
}

export function systemCommandForTarget(target: GuestTarget): QemuSystemCommand {
  switch (target) {
    case "x86_64":
      return "qemu-system-x86_64";
    case "aarch64":
      return "qemu-system-aarch64";
    case "riscv64":
      return "qemu-system-riscv64";
  }
}

/**
 * Builds the `-accel` arguments. "auto" produces a host-appropriate
 * accelerator followed by a tcg fallback: QEMU tries each `-accel` in order
 * and uses the first one that initializes, so we don't have to predict host
 * capability ourselves.
 */
export function getAccelerationArgs(
  mode: AccelerationMode,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (mode === "tcg") return ["-accel", "tcg"];
  if (mode === "kvm") return ["-accel", "kvm"];
  if (mode === "hvf") return ["-accel", "hvf"];
  if (mode === "whpx") return ["-accel", "whpx"];

  if (platform === "linux") return ["-accel", "kvm", "-accel", "tcg"];
  if (platform === "darwin") return ["-accel", "hvf", "-accel", "tcg"];
  if (platform === "win32") return ["-accel", "whpx", "-accel", "tcg"];
  return ["-accel", "tcg"];
}

function diskArgs(disk: DiskConfig, index: number): string[] {
  const parts = [`file=${escapeQemuOptionValue(disk.path)}`];
  if (disk.format) parts.push(`format=${disk.format}`);
  parts.push(`if=${disk.interface ?? "virtio"}`);
  parts.push(`index=${index}`);
  if (disk.readonly) parts.push("readonly=on");
  if (disk.snapshot) parts.push("snapshot=on");
  return ["-drive", parts.join(",")];
}

function hostForwardSpec(fwd: HostForward): string {
  if (!Number.isInteger(fwd.hostPort) || !Number.isInteger(fwd.guestPort)) {
    throw new InvalidVmConfigError(
      `Host forward ports must be integers (got host=${fwd.hostPort}, guest=${fwd.guestPort}).`
    );
  }
  const hostAddr = fwd.hostAddress ?? "127.0.0.1";
  const guestAddr = fwd.guestAddress ?? "";
  return `hostfwd=${fwd.protocol}:${hostAddr}:${fwd.hostPort}-${guestAddr}:${fwd.guestPort}`;
}

function networkArgs(network: NetworkConfig): string[] {
  if (network.type === "none") return ["-nic", "none"];

  const netdevParts = ["user", "id=net0"];
  for (const fwd of network.hostForwards ?? []) {
    netdevParts.push(hostForwardSpec(fwd));
  }
  return [
    "-netdev",
    netdevParts.join(","),
    "-device",
    "virtio-net-pci,netdev=net0",
  ];
}

function qmpArgs(qmp: QmpConfig): string[] {
  if (!qmp.enabled) return [];
  if (!qmp.socketPath) {
    throw new InvalidVmConfigError(
      "qmp.enabled requires qmp.socketPath (a local Unix socket path)."
    );
  }
  const server = qmp.server ?? true;
  const wait = qmp.wait ?? false;
  // Local IPC only: QMP is a privileged control interface and must never be
  // exposed on a routable address.
  return [
    "-qmp",
    `unix:${escapeQemuOptionValue(qmp.socketPath)},server=${server ? "on" : "off"},wait=${wait ? "on" : "off"}`,
  ];
}

function serialArgs(serial: NonNullable<VmConfig["serial"]>): string[] {
  if (serial === "stdio") return ["-serial", "stdio"];
  if (serial === "none") return ["-serial", "none"];
  return ["-serial", `file:${serial.file}`];
}

/**
 * Translates a {@link VmConfig} into a full, auditable QEMU argv. Pure
 * function: no host detection beyond the injectable `platform`, no
 * filesystem access, no binary resolution.
 */
export function buildQemuSystemArgs(
  config: VmConfig,
  platform: NodeJS.Platform = process.platform
): { command: QemuSystemCommand; args: string[] } {
  const command = systemCommandForTarget(config.target);
  const args: string[] = [];

  if (config.name) args.push("-name", escapeQemuOptionValue(config.name));
  if (config.machine) args.push("-machine", config.machine);
  if (config.cpu) args.push("-cpu", config.cpu);

  if (config.memory !== undefined) {
    args.push(
      "-m",
      typeof config.memory === "number" ? `${config.memory}M` : config.memory
    );
  }
  if (config.smp !== undefined) {
    if (!Number.isInteger(config.smp) || config.smp < 1) {
      throw new InvalidVmConfigError(`smp must be a positive integer (got ${config.smp}).`);
    }
    args.push("-smp", String(config.smp));
  }

  args.push(...getAccelerationArgs(config.acceleration ?? "auto", platform));

  // Secure defaults: headless unless the caller opts into a display.
  args.push("-display", config.display ?? "none");

  if (config.serial) args.push(...serialArgs(config.serial));
  if (config.qmp) args.push(...qmpArgs(config.qmp));

  (config.disks ?? []).forEach((disk, i) => args.push(...diskArgs(disk, i)));
  if (config.cdrom) args.push("-cdrom", config.cdrom);

  if (config.kernel) {
    args.push("-kernel", config.kernel.kernel);
    if (config.kernel.initrd) args.push("-initrd", config.kernel.initrd);
    if (config.kernel.append) args.push("-append", config.kernel.append);
  }

  // Secure default: no NIC at all unless networking is requested.
  args.push(...networkArgs(config.network ?? { type: "none" }));

  if (config.extraArgs) args.push(...config.extraArgs);

  return { command, args };
}
