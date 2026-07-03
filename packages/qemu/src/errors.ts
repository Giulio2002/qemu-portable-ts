import type { QemuExitResult } from "./process";

/** Base class for every error thrown by qemu-portable. */
export abstract class QemuError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The host OS/arch/libc combination has no vendored binary package. */
export class UnsupportedPlatformError extends QemuError {
  readonly code = "ERR_QEMU_UNSUPPORTED_PLATFORM";
}

/**
 * The platform binary package (or a binary inside it) could not be found.
 * Usually means optional dependencies were omitted at install time.
 */
export class QemuBinaryNotFoundError extends QemuError {
  readonly code = "ERR_QEMU_BINARY_NOT_FOUND";
}

/** A QEMU process exited with a non-zero code or was killed by a signal. */
export class QemuCommandError extends QemuError {
  readonly code = "ERR_QEMU_COMMAND_FAILED";
  readonly result: QemuExitResult;
  constructor(message: string, result: QemuExitResult) {
    const stderr = result.stderr?.toString("utf8").trim();
    super(stderr ? `${message}\n\nstderr:\n${stderr}` : message);
    this.result = result;
  }
}

/** A short-running QEMU command exceeded its timeout. */
export class QemuTimeoutError extends QemuError {
  readonly code = "ERR_QEMU_TIMEOUT";
}

/** The QMP server returned an error or violated the protocol. */
export class QmpProtocolError extends QemuError {
  readonly code = "ERR_QMP_PROTOCOL";
  readonly errorClass?: string;
  constructor(message: string, errorClass?: string) {
    super(message);
    this.errorClass = errorClass;
  }
}

/**
 * The QEMU Guest Agent channel errored, timed out, or the guest agent is not
 * responding (e.g. not installed/running in the guest, or the guest has not
 * finished booting).
 */
export class GuestAgentError extends QemuError {
  readonly code = "ERR_QEMU_GUEST_AGENT";
  readonly errorClass?: string;
  constructor(message: string, errorClass?: string) {
    super(message);
    this.errorClass = errorClass;
  }
}

/** A VM configuration cannot be translated into valid QEMU arguments. */
export class InvalidVmConfigError extends QemuError {
  readonly code = "ERR_QEMU_INVALID_VM_CONFIG";
}

/**
 * A command string that is not one of the known QEMU commands was passed to
 * the resolver/process layer. Guards against path traversal and arbitrary
 * binary execution when a caller forwards untrusted input as a command.
 */
export class QemuInvalidCommandError extends QemuError {
  readonly code = "ERR_QEMU_INVALID_COMMAND";
}
