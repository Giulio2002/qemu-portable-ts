import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiskConfig, VmConfig, buildQemuSystemArgs } from "./args";
import { GuestAgentError } from "./errors";
import { QemuSystemCommand } from "./platform";
import { QemuProcess, QemuRunOptions, spawnQemu } from "./process";
import {
  MaterializedSecret,
  PassphraseSource,
  materializePassphrase,
} from "./secret";
import {
  ResolveQemuOptions,
  ResolvedQemuBinary,
  resolveQemuBinary,
} from "./resolve";
import {
  GuestExecOptions,
  GuestExecResult,
  execInGuest,
} from "./qmp/guest-agent";

export interface BuiltVmCommand {
  command: QemuSystemCommand;
  args: string[];
  resolved: ResolvedQemuBinary;
}

/**
 * A disk as accepted by {@link createVm}, which — unlike the pure arg
 * builders — can take an inline `passphrase` and write the key file itself.
 */
export type VmDiskInput = Omit<DiskConfig, "encryption"> & {
  encryption?: PassphraseSource;
};

/** {@link VmConfig} with the more permissive disk encryption input. */
export type CreateVmConfig = Omit<VmConfig, "disks"> & {
  disks?: VmDiskInput[];
};

export interface QemuVm {
  config: VmConfig;
  /**
   * Host socket path for the guest agent channel, when guestAgent is enabled.
   * `undefined` if the VM was created without a guest agent.
   */
  guestAgentSocketPath?: string;
  /** Resolve the binary and produce the exact argv that start() would use. */
  build(): BuiltVmCommand;
  start(options?: QemuRunOptions): QemuProcess;
  /**
   * Run a command inside the guest via the QEMU Guest Agent and return its
   * exit code, stdout, and stderr. Requires the VM to have been created with
   * `guestAgent: true` (or a guestAgent config) and `qemu-guest-agent`
   * running in the guest. A string runs through a shell (so `&&`, pipes, and
   * redirection work); an argv array runs a binary directly.
   */
  exec(command: string | string[], options?: GuestExecOptions): Promise<GuestExecResult>;
  /**
   * Deletes any passphrase files this VM wrote from an inline `passphrase`.
   * `start()` already does this when the QEMU process exits; call it yourself
   * if you only ever called `build()`, or to drop the keys early. Files you
   * supplied as `passphraseFile` are never touched.
   */
  cleanupSecrets(): void;
}

export interface CreateVmOptions {
  /** Resolver options (platform override, search paths — mainly for tests). */
  resolve?: Omit<ResolveQemuOptions, "command">;
  /** Inject a pre-resolved binary; skips resolution entirely (tests). */
  resolveBinary?: (command: QemuSystemCommand) => ResolvedQemuBinary;
}

/**
 * Normalizes config.guestAgent: when enabled without an explicit socket path,
 * provisions one under a private temp directory so both build() and exec()
 * agree on the same path. Returns the (possibly rewritten) config and the
 * resolved socket path.
 */
function normalizeGuestAgent(config: VmConfig): {
  config: VmConfig;
  guestAgentSocketPath?: string;
} {
  if (!config.guestAgent) return { config };
  const provided = config.guestAgent === true ? undefined : config.guestAgent.socketPath;
  const socketPath =
    provided ?? join(mkdtempSync(join(tmpdir(), "qemu-qga-")), "qga.sock");
  return {
    config: { ...config, guestAgent: { socketPath } },
    guestAgentSocketPath: socketPath,
  };
}

/**
 * Writes a key file for every disk that was given an inline passphrase, and
 * rewrites those disks to the file-only shape the pure builders accept.
 * Disks that already point at a `passphraseFile` pass through untouched.
 */
function normalizeDiskSecrets(config: CreateVmConfig): {
  config: VmConfig;
  secrets: MaterializedSecret[];
} {
  const secrets: MaterializedSecret[] = [];
  if (!config.disks?.some((disk) => disk.encryption)) {
    return { config: config as VmConfig, secrets };
  }

  const disks: DiskConfig[] = config.disks.map((disk) => {
    if (!disk.encryption) return disk as DiskConfig;
    const secret = materializePassphrase(disk.encryption);
    // Only track what we created, so cleanup can never delete a caller's file.
    if (disk.encryption.passphrase !== undefined) secrets.push(secret);
    return { ...disk, encryption: { passphraseFile: secret.file } };
  });

  return { config: { ...config, disks }, secrets };
}

/** Builds args and resolves the vendored binary without starting anything. */
export function buildVmArgs(
  config: VmConfig,
  options: CreateVmOptions = {}
): BuiltVmCommand {
  const { command, args } = buildQemuSystemArgs(config);
  const resolved = options.resolveBinary
    ? options.resolveBinary(command)
    : resolveQemuBinary(command, options.resolve);
  return { command, args, resolved };
}

/**
 * Creates a VM handle from a config. Nothing runs until start() is called;
 * build() exposes the exact command line for auditing or logging first.
 */
export function createVm(
  config: CreateVmConfig,
  options: CreateVmOptions = {}
): QemuVm {
  const { config: withSecrets, secrets } = normalizeDiskSecrets(config);
  const { config: normalizedConfig, guestAgentSocketPath } =
    normalizeGuestAgent(withSecrets);

  const cleanupSecrets = (): void => {
    for (const secret of secrets) secret.cleanup();
  };

  return {
    config: normalizedConfig,
    guestAgentSocketPath,
    cleanupSecrets,
    build() {
      return buildVmArgs(normalizedConfig, options);
    },
    start(runOptions: QemuRunOptions = {}) {
      const built = buildVmArgs(normalizedConfig, options);
      const proc = spawnQemu(built.command, built.args, {
        ...runOptions,
        resolved: built.resolved,
      });
      // QEMU reads secrets once, at startup, so the key files are only needed
      // for the life of the process. Drop them as soon as it is gone rather
      // than leaving passphrases in the temp directory.
      proc.child.once("close", cleanupSecrets);
      proc.child.once("error", cleanupSecrets);
      return proc;
    },
    exec(command: string | string[], execOptions: GuestExecOptions = {}) {
      if (!guestAgentSocketPath) {
        return Promise.reject(
          new GuestAgentError(
            "vm.exec() requires the guest agent. Create the VM with " +
              "`guestAgent: true` and make sure qemu-guest-agent is running " +
              "in the guest."
          )
        );
      }
      return execInGuest(guestAgentSocketPath, command, execOptions);
    },
  };
}
