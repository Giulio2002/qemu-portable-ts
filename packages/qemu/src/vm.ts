import { VmConfig, buildQemuSystemArgs } from "./args";
import { QemuSystemCommand } from "./platform";
import { QemuProcess, QemuRunOptions, spawnQemu } from "./process";
import {
  ResolveQemuOptions,
  ResolvedQemuBinary,
  resolveQemuBinary,
} from "./resolve";

export interface BuiltVmCommand {
  command: QemuSystemCommand;
  args: string[];
  resolved: ResolvedQemuBinary;
}

export interface QemuVm {
  config: VmConfig;
  /** Resolve the binary and produce the exact argv that start() would use. */
  build(): BuiltVmCommand;
  start(options?: QemuRunOptions): QemuProcess;
}

export interface CreateVmOptions {
  /** Resolver options (platform override, search paths — mainly for tests). */
  resolve?: Omit<ResolveQemuOptions, "command">;
  /** Inject a pre-resolved binary; skips resolution entirely (tests). */
  resolveBinary?: (command: QemuSystemCommand) => ResolvedQemuBinary;
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
export function createVm(config: VmConfig, options: CreateVmOptions = {}): QemuVm {
  return {
    config,
    build() {
      return buildVmArgs(config, options);
    },
    start(runOptions: QemuRunOptions = {}) {
      const built = buildVmArgs(config, options);
      return spawnQemu(built.command, built.args, {
        ...runOptions,
        resolved: built.resolved,
      });
    },
  };
}
