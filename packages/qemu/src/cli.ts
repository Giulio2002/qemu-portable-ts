#!/usr/bin/env node
/**
 * qemu-ts — diagnostics and direct-run CLI for @org/qemu.
 *
 * Commands:
 *   qemu-ts diagnostics
 *   qemu-ts version [command]
 *   qemu-ts which <command>
 *   qemu-ts run <command> -- <raw qemu args...>
 */

import { formatDiagnostics, getQemuDiagnostics } from "./diagnostics";
import { QemuError } from "./errors";
import { MVP_COMMANDS, QemuCommand } from "./platform";
import { spawnQemu } from "./process";
import { resolveQemuBinary } from "./resolve";
import { getQemuVersion } from "./version";

const USAGE = `qemu-ts — run vendored QEMU binaries

Usage:
  qemu-ts diagnostics                       Print platform/package/binary report
  qemu-ts version [command]                 Print QEMU version (default: qemu-img)
  qemu-ts which <command>                   Print resolved vendored binary path
  qemu-ts run <command> -- <qemu args...>   Run a vendored binary with raw args

Commands: ${MVP_COMMANDS.join(", ")}, qemu-system-riscv64

Notes:
  - "run" requires "--" before raw QEMU arguments.
  - The CLI never falls back to a system-installed QEMU.
  - "run" exits with the same code as the QEMU process.
`;

const KNOWN_COMMANDS: QemuCommand[] = [
  "qemu-system-x86_64",
  "qemu-system-aarch64",
  "qemu-system-riscv64",
  "qemu-img",
];

function parseQemuCommand(value: string | undefined, context: string): QemuCommand {
  if (!value) {
    process.stderr.write(`Missing QEMU command for "${context}".\n\n${USAGE}`);
    process.exit(2);
  }
  if (!KNOWN_COMMANDS.includes(value as QemuCommand)) {
    process.stderr.write(
      `Unknown QEMU command "${value}". Known commands: ${KNOWN_COMMANDS.join(", ")}\n`
    );
    process.exit(2);
  }
  return value as QemuCommand;
}

async function main(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;

  switch (subcommand) {
    case "diagnostics": {
      const diag = await getQemuDiagnostics();
      process.stdout.write(formatDiagnostics(diag) + "\n");
      return 0;
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
            `  qemu-ts run ${command} -- --version\n`
        );
        return 2;
      }
      const qemuArgs = rest.slice(sepIndex + 1);
      const resolved = resolveQemuBinary(command);
      process.stderr.write(`[qemu-ts] running: ${resolved.path}\n`);
      const proc = spawnQemu(command, qemuArgs, {
        stdio: "inherit",
        resolved,
      });
      const result = await proc.wait();
      if (result.signal) {
        process.stderr.write(`[qemu-ts] killed by signal ${result.signal}\n`);
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
