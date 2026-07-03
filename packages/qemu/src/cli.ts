#!/usr/bin/env node
/**
 * qemu-portable — diagnostics and direct-run CLI for qemu-portable.
 *
 * Commands:
 *   qemu-portable diagnostics
 *   qemu-portable version [command]
 *   qemu-portable which <command>
 *   qemu-portable run <command> -- <raw qemu args...>
 */

import { formatDiagnostics, getQemuDiagnostics } from "./diagnostics";
import { QemuError } from "./errors";
import { checkHostSupport, getQemuFeatures } from "./features";
import { KNOWN_QEMU_COMMANDS, QemuCommandName } from "./platform";
import { spawnQemu } from "./process";
import { resolveQemuBinary } from "./resolve";
import { getQemuVersion } from "./version";

const USAGE = `qemu-portable — run vendored QEMU binaries

Usage:
  qemu-portable diagnostics                       Print platform/package/binary report
  qemu-portable features                          Print build feature flags as JSON
  qemu-portable preflight                         Host-support check (exit 0 = usable)
  qemu-portable version [command]                 Print QEMU version (default: qemu-img)
  qemu-portable which <command>                   Print resolved vendored binary path
  qemu-portable run <command> -- <qemu args...>   Run a vendored binary with raw args

Common commands: ${KNOWN_QEMU_COMMANDS.join(", ")}
(any binary shipped in the platform package can be run, e.g. qemu-io, qemu-nbd)

Notes:
  - "run" requires "--" before raw QEMU arguments.
  - The CLI never falls back to a system-installed QEMU.
  - "run" exits with the same code as the QEMU process.
`;

// No allowlist: accept any command name. The resolver still refuses names
// that would escape the package's bin/ directory.
function parseQemuCommand(value: string | undefined, context: string): QemuCommandName {
  if (!value) {
    process.stderr.write(`Missing QEMU command for "${context}".\n\n${USAGE}`);
    process.exit(2);
  }
  return value;
}

async function main(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case "diagnostics": {
      const diag = await getQemuDiagnostics();
      process.stdout.write(formatDiagnostics(diag) + "\n");
      return 0;
    }

    case "features": {
      const features = getQemuFeatures();
      process.stdout.write(JSON.stringify(features, null, 2) + "\n");
      return 0;
    }

    case "preflight": {
      const report = checkHostSupport();
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return report.ok ? 0 : 1;
    }

    case "version": {
      const command = rest[0] ? parseQemuCommand(rest[0], "version") : "qemu-img";
      const info = await getQemuVersion(command);
      process.stdout.write(
        `${info.command} ${info.qemuVersion}\n` +
          `binary: ${info.binary.path}\n` +
          `package: ${info.binary.packageName}\n`
      );
      return 0;
    }

    case "which": {
      const command = parseQemuCommand(rest[0], "which");
      const resolved = resolveQemuBinary(command);
      process.stdout.write(`${resolved.path}\n`);
      return 0;
    }

    case "run": {
      const command = parseQemuCommand(rest[0], "run");
      const sepIndex = rest.indexOf("--");
      if (sepIndex === -1) {
        process.stderr.write(
          `"run" requires "--" before raw QEMU arguments, e.g.\n` +
            `  qemu-portable run ${command} -- --version\n`
        );
        return 2;
      }
      const qemuArgs = rest.slice(sepIndex + 1);
      const resolved = resolveQemuBinary(command);
      process.stderr.write(`[qemu-portable] running: ${resolved.path}\n`);
      const proc = spawnQemu(command, qemuArgs, {
        stdio: "inherit",
        resolved,
      });
      const result = await proc.wait();
      if (result.signal) {
        process.stderr.write(`[qemu-portable] killed by signal ${result.signal}\n`);
        return 1;
      }
      return result.code ?? 1;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      process.stdout.write(USAGE);
      return subcommand === undefined ? 2 : 0;
    }

    default: {
      process.stderr.write(`Unknown subcommand "${subcommand}".\n\n${USAGE}`);
      return 2;
    }
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof QemuError) {
      process.stderr.write(`${err.name} [${err.code}]\n${err.message}\n`);
    } else {
      process.stderr.write(`Unexpected error: ${(err as Error).stack ?? err}\n`);
    }
    process.exitCode = 1;
  });
