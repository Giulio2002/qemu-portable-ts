import { QemuCommandError } from "./errors";
import { QemuCommandName } from "./platform";
import { QemuRunOptions, execQemu } from "./process";
import { ResolvedQemuBinary, resolveQemuBinary } from "./resolve";

export interface QemuVersionInfo {
  command: QemuCommandName;
  qemuVersion: string;
  rawOutput: string;
  binary: ResolvedQemuBinary;
}

/**
 * Extracts the semantic version from `--version` output such as
 * "QEMU emulator version 10.0.2" or "qemu-img version 10.0.2".
 */
export function parseQemuVersionOutput(output: string): string | undefined {
  const match = output.match(/version\s+([0-9]+(?:\.[0-9]+)*(?:[-+~][^\s(]*)?)/i);
  return match?.[1];
}

/** Runs `<command> --version` against the vendored binary and parses it. */
export async function getQemuVersion(
  command: QemuCommandName = "qemu-img",
  options: QemuRunOptions = {}
): Promise<QemuVersionInfo> {
  const binary = options.resolved ?? resolveQemuBinary(command, options.resolve);
  const result = await execQemu(command, ["--version"], {
    timeoutMs: 30_000,
    ...options,
    resolved: binary,
    // --version must not depend on the data dir; keep the invocation minimal.
    noDataDir: true,
  });
  const rawOutput = (result.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  if (result.code !== 0) {
    throw new QemuCommandError(`${command} --version failed`, result);
  }
  const qemuVersion = parseQemuVersionOutput(rawOutput);
  if (!qemuVersion) {
    throw new QemuCommandError(
      `Could not parse QEMU version from output: ${JSON.stringify(rawOutput)}`,
      result
    );
  }
  return { command, qemuVersion, rawOutput, binary };
}
