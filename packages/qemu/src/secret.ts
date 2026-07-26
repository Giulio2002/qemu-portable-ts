import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvalidImageConfigError } from "./errors";

/**
 * Where the passphrase for an encrypted image comes from.
 *
 * `passphraseFile` points at a file whose **entire contents** are the
 * passphrase. QEMU reads the file verbatim, so a trailing newline becomes part
 * of the passphrase — `printf '%s' pass > key.txt`, not `echo pass > key.txt`.
 * This is the single most common cause of "Invalid password, cannot unlock any
 * keyslot" on an otherwise correct setup.
 *
 * `passphrase` is a convenience for callers holding the secret in memory: the
 * stateful helpers write it to a private temp file (0600 inside a 0700
 * directory) for the duration of the command and delete it afterwards. The
 * pure arg builders never accept it, because writing that file is I/O.
 *
 * A passphrase is never placed on the command line in either case: argv is
 * world-readable through `ps` on most systems.
 */
export type PassphraseSource =
  | { passphraseFile: string; passphrase?: never }
  | { passphrase: string; passphraseFile?: never };

/** A `secret` object QEMU loads a passphrase from, already reduced to a file. */
export interface QemuSecret {
  /** Object id referenced by `key-secret=` / `encrypt.key-secret=`. */
  id: string;
  /** Host path whose exact bytes are the passphrase. */
  file: string;
}

/**
 * Secret ids are interpolated into QEMU option strings and referenced by
 * other options, so they are restricted to characters that cannot terminate
 * an option, start a new one, or be mistaken for a value separator.
 */
const SAFE_SECRET_ID = /^[A-Za-z0-9_-]+$/;

export function validateSecretId(id: string): string {
  if (!SAFE_SECRET_ID.test(id)) {
    throw new InvalidImageConfigError(
      `Invalid secret id ${JSON.stringify(id)}: only letters, digits, "_" ` +
        `and "-" are allowed. This restriction prevents QEMU option injection.`
    );
  }
  return id;
}

/** QEMU option values escape "," by doubling it. */
function escape(value: string): string {
  return value.replace(/,/g, ",,");
}

/**
 * Builds the `secret` object argument that makes a passphrase available to a
 * QEMU command under {@link QemuSecret.id}.
 *
 * `format=raw` declares the file to hold the passphrase bytes themselves
 * rather than base64. Use `flag: "--object"` for qemu-img (where it must
 * precede the positional arguments) and `"-object"` for the system emulator.
 */
export function secretObjectArgs(
  secret: QemuSecret,
  flag: "--object" | "-object" = "--object"
): string[] {
  validateSecretId(secret.id);
  return [
    flag,
    `secret,id=${secret.id},file=${escape(secret.file)},format=raw`,
  ];
}

/** A passphrase file plus the cleanup for it, if we created it ourselves. */
export interface MaterializedSecret {
  file: string;
  /** Removes the temp file when one was written; a no-op for caller files. */
  cleanup(): void;
}

/**
 * Reduces a {@link PassphraseSource} to a file on disk.
 *
 * A caller-supplied `passphraseFile` is used as-is and never deleted. An
 * inline `passphrase` is written to a fresh 0600 file inside a 0700 temp
 * directory, with **no trailing newline added**, and `cleanup()` removes the
 * whole directory.
 *
 * File modes are advisory on Windows, where the temp directory being
 * per-user is what limits access.
 */
export function materializePassphrase(source: PassphraseSource): MaterializedSecret {
  if (source.passphraseFile !== undefined) {
    if (source.passphraseFile === "") {
      throw new InvalidImageConfigError("passphraseFile must not be empty.");
    }
    return { file: source.passphraseFile, cleanup: () => {} };
  }

  if (typeof source.passphrase !== "string" || source.passphrase.length === 0) {
    throw new InvalidImageConfigError(
      "Encryption requires either a non-empty `passphrase` or a `passphraseFile`."
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "qemu-secret-"));
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort: Windows has no POSIX mode bits.
  }
  const file = join(dir, "passphrase");
  // Written verbatim: any added newline would change the passphrase.
  writeFileSync(file, source.passphrase, { mode: 0o600 });

  return {
    file,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Already gone, or removed by an exit hook.
      }
    },
  };
}
