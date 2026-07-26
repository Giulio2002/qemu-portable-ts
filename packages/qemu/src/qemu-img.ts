import { InvalidImageConfigError, QemuCommandError } from "./errors";
import { QemuExitResult, QemuRunOptions, execQemu } from "./process";
import {
  MaterializedSecret,
  PassphraseSource,
  materializePassphrase,
  secretObjectArgs,
} from "./secret";

export type DiskImageFormat = "qcow2" | "raw" | "vmdk" | "vdi" | "vpc" | "luks";

/** Formats that can carry a LUKS-encrypted payload. */
export type EncryptableFormat = "qcow2" | "luks";

// --- encryption ----------------------------------------------------------------

/**
 * LUKS parameters. Every field is optional; omitting all of them gets QEMU's
 * defaults, which are the sensible modern choice (aes-256 in xts mode with a
 * sha256 hash and plain64 IV generation).
 */
export interface LuksParameters {
  cipherAlg?:
    | "aes-128" | "aes-192" | "aes-256"
    | "twofish-128" | "twofish-192" | "twofish-256"
    | "serpent-128" | "serpent-192" | "serpent-256"
    | "cast5-128";
  cipherMode?: "xts" | "cbc" | "ecb" | "ctr";
  ivgenAlg?: "plain" | "plain64" | "essiv";
  ivgenHashAlg?: "sha1" | "sha256" | "sha512" | "ripemd160";
  hashAlg?: "sha1" | "sha256" | "sha512" | "ripemd160";
  /**
   * Milliseconds to spend in PBKDF per keyslot. Higher is more resistant to
   * offline brute force but slows every open. QEMU's default (~2s) is right
   * for real data; tests use a small value to stay fast.
   */
  iterTime?: number;
}

/** LUKS encryption for a new image, plus where its passphrase comes from. */
export type LuksEncryption = LuksParameters & PassphraseSource;

/**
 * qcow2-specific creation knobs. These are independent of encryption — a
 * plain qcow2 image can use them too.
 */
export interface Qcow2Parameters {
  /** Cluster size, e.g. "64k" (QEMU default) or "2M". Powers of two, 512..2M. */
  clusterSize?: string;
  /** "1.1" (v3, default) or "0.10" (v2, readable by very old QEMU). */
  compat?: "0.10" | "1.1";
  /** Faster writes, at the cost of needing a repair pass after a crash. */
  lazyRefcounts?: boolean;
  /** Extended L2 entries: subcluster allocation, needs compat 1.1. */
  extendedL2?: boolean;
  refcountBits?: number;
  compressionType?: "zlib" | "zstd";
}

// --- option objects ------------------------------------------------------------

export interface CreateImageOptions {
  path: string;
  /** Size accepted by qemu-img, e.g. "20G", "512M", or bytes as a string. */
  size: string;
  format?: DiskImageFormat;
  backingFile?: string;
  backingFormat?: DiskImageFormat;
  preallocation?: "off" | "metadata" | "falloc" | "full";
  /** qcow2 tuning; ignored by (and invalid for) other formats. */
  qcow2?: Qcow2Parameters;
  /**
   * Encrypt the new image with LUKS. Valid for `format: "qcow2"` (LUKS-encrypted
   * clusters inside a qcow2 container) and `format: "luks"` (a bare LUKS
   * container, the same on-disk format cryptsetup produces).
   */
  encryption?: LuksEncryption;
}

export interface ConvertImageOptions {
  input: string;
  output: string;
  inputFormat?: DiskImageFormat;
  outputFormat: DiskImageFormat;
  compressed?: boolean;
  /**
   * Passphrase for an encrypted *source* image. Requires `inputFormat`, since
   * an encrypted image must be opened through an explicit driver spec.
   */
  inputEncryption?: PassphraseSource;
  /** Encrypt the *output*. `outputFormat` must be "qcow2" or "luks". */
  outputEncryption?: LuksEncryption;
}

export interface ResizeImageOptions {
  path: string;
  /** Absolute ("20G") or relative ("+5G") size. */
  size: string;
  format?: DiskImageFormat;
  /** Required to shrink an image; adds --shrink. */
  shrink?: boolean;
  /** Passphrase for an encrypted image. Requires `format`. */
  encryption?: PassphraseSource;
}

export interface CheckImageOptions {
  format?: DiskImageFormat;
  repair?: "leaks" | "all";
  /** Passphrase for an encrypted image. Requires `format`. */
  encryption?: PassphraseSource;
}

export interface InfoImageOptions {
  format?: DiskImageFormat;
  /** Passphrase for an encrypted image. Requires `format`. */
  encryption?: PassphraseSource;
}

export interface ImageInfo {
  path: string;
  format?: string;
  virtualSize?: number;
  actualSize?: number;
  /** True when the image reports itself as encrypted. */
  encrypted?: boolean;
  raw: unknown;
}

// --- internals -----------------------------------------------------------------

/** Fixed id for the single secret these helpers ever install. */
const SECRET_ID = "sec0";

/** QEMU option values escape "," by doubling it. */
function escape(value: string): string {
  return value.replace(/,/g, ",,");
}

function assertEncryptable(format: DiskImageFormat): EncryptableFormat {
  if (format !== "qcow2" && format !== "luks") {
    throw new InvalidImageConfigError(
      `Format ${JSON.stringify(format)} cannot be encrypted. Use "qcow2" ` +
        `(LUKS-encrypted clusters in a qcow2 container) or "luks" (a bare ` +
        `LUKS container).`
    );
  }
  return format;
}

/**
 * qcow2 namespaces its encryption settings under `encrypt.`, while the bare
 * `luks` driver takes the same settings at the top level. Everything that
 * touches an encrypted image has to agree on this prefix.
 */
function encryptPrefix(format: EncryptableFormat): string {
  return format === "qcow2" ? "encrypt." : "";
}

/** `-o` settings that create the LUKS payload. */
function luksCreateOptions(
  encryption: LuksParameters,
  format: EncryptableFormat,
  secretId: string
): string[] {
  const p = encryptPrefix(format);
  const opts: string[] = [];
  // qcow2 needs to be told which encryption scheme; the luks driver is one.
  if (format === "qcow2") opts.push(`${p}format=luks`);
  opts.push(`${p}key-secret=${secretId}`);
  if (encryption.cipherAlg) opts.push(`${p}cipher-alg=${encryption.cipherAlg}`);
  if (encryption.cipherMode) opts.push(`${p}cipher-mode=${encryption.cipherMode}`);
  if (encryption.ivgenAlg) opts.push(`${p}ivgen-alg=${encryption.ivgenAlg}`);
  if (encryption.ivgenHashAlg) {
    opts.push(`${p}ivgen-hash-alg=${encryption.ivgenHashAlg}`);
  }
  if (encryption.hashAlg) opts.push(`${p}hash-alg=${encryption.hashAlg}`);
  if (encryption.iterTime !== undefined) {
    if (!Number.isInteger(encryption.iterTime) || encryption.iterTime < 0) {
      throw new InvalidImageConfigError(
        `iterTime must be a non-negative integer number of milliseconds ` +
          `(got ${encryption.iterTime}).`
      );
    }
    opts.push(`${p}iter-time=${encryption.iterTime}`);
  }
  return opts;
}

function qcow2CreateOptions(qcow2: Qcow2Parameters): string[] {
  const opts: string[] = [];
  if (qcow2.clusterSize) opts.push(`cluster_size=${escape(qcow2.clusterSize)}`);
  if (qcow2.compat) opts.push(`compat=${qcow2.compat}`);
  if (qcow2.lazyRefcounts !== undefined) {
    opts.push(`lazy_refcounts=${qcow2.lazyRefcounts ? "on" : "off"}`);
  }
  if (qcow2.extendedL2 !== undefined) {
    opts.push(`extended_l2=${qcow2.extendedL2 ? "on" : "off"}`);
  }
  if (qcow2.refcountBits !== undefined) {
    opts.push(`refcount_bits=${qcow2.refcountBits}`);
  }
  if (qcow2.compressionType) {
    opts.push(`compression_type=${qcow2.compressionType}`);
  }
  return opts;
}

/**
 * Builds the `--image-opts` driver spec used to *read* an encrypted image.
 *
 * An encrypted image cannot be opened with plain `-f <fmt> <path>`: there is
 * nowhere in that form to attach the key. QEMU's answer is an explicit
 * blockdev spec, which also means the format must be stated rather than
 * probed.
 */
export function encryptedImageOptsSpec(
  path: string,
  format: EncryptableFormat,
  secretId: string = SECRET_ID
): string {
  const p = encryptPrefix(format);
  return [
    `driver=${format}`,
    `file.filename=${escape(path)}`,
    `${p}key-secret=${secretId}`,
  ].join(",");
}

function requireFormatForEncryption(
  format: DiskImageFormat | undefined,
  what: string
): EncryptableFormat {
  if (!format) {
    throw new InvalidImageConfigError(
      `${what} on an encrypted image requires an explicit \`format\`: an ` +
        `encrypted image is opened through a driver spec, which cannot be ` +
        `probed from the file.`
    );
  }
  return assertEncryptable(format);
}

// --- pure arg builders ---------------------------------------------------------
// Every builder takes an already-resolved secret file, so it stays free of I/O
// and unit-testable without a binary installed.

export function createImageArgs(
  options: CreateImageOptions,
  secretFile?: string
): string[] {
  const format = options.format ?? "qcow2";
  // The subcommand comes first: qemu-img parses options per subcommand and
  // rejects a leading `--object` outright.
  const args: string[] = ["create"];

  if (options.encryption) {
    if (!secretFile) {
      throw new InvalidImageConfigError(
        "createImageArgs() needs the passphrase already written to a file. " +
          "qemuImg.create() does that for you; call it instead, or pass the " +
          "file path as the second argument."
      );
    }
    args.push(...secretObjectArgs({ id: SECRET_ID, file: secretFile }));
  }

  args.push("-f", format);

  if (options.backingFile) {
    args.push("-b", options.backingFile);
    if (options.backingFormat) args.push("-F", options.backingFormat);
  }

  const createOpts: string[] = [];
  if (options.preallocation) {
    createOpts.push(`preallocation=${options.preallocation}`);
  }
  if (options.qcow2) {
    if (format !== "qcow2") {
      throw new InvalidImageConfigError(
        `qcow2 options were given for format ${JSON.stringify(format)}.`
      );
    }
    createOpts.push(...qcow2CreateOptions(options.qcow2));
  }
  if (options.encryption) {
    createOpts.push(
      ...luksCreateOptions(options.encryption, assertEncryptable(format), SECRET_ID)
    );
  }
  if (createOpts.length > 0) args.push("-o", createOpts.join(","));

  args.push(options.path, options.size);
  return args;
}

export function convertImageArgs(
  options: ConvertImageOptions,
  secretFiles: { input?: string; output?: string } = {}
): string[] {
  const args: string[] = ["convert"];

  const inputSecretId = "sec-in";
  const outputSecretId = "sec-out";

  if (options.inputEncryption) {
    if (!secretFiles.input) {
      throw new InvalidImageConfigError(
        "convertImageArgs() needs the input passphrase already written to a " +
          "file. qemuImg.convert() does that for you."
      );
    }
    args.push(...secretObjectArgs({ id: inputSecretId, file: secretFiles.input }));
  }
  if (options.outputEncryption) {
    if (!secretFiles.output) {
      throw new InvalidImageConfigError(
        "convertImageArgs() needs the output passphrase already written to a " +
          "file. qemuImg.convert() does that for you."
      );
    }
    args.push(...secretObjectArgs({ id: outputSecretId, file: secretFiles.output }));
  }

  if (options.compressed) args.push("-c");

  // An encrypted source is addressed by --image-opts instead of -f, further
  // down; an unencrypted one keeps -f here so the argv order stays familiar.
  if (!options.inputEncryption && options.inputFormat) {
    args.push("-f", options.inputFormat);
  }

  args.push("-O", options.outputFormat);

  if (options.outputEncryption) {
    const outFormat = assertEncryptable(options.outputFormat);
    args.push(
      "-o",
      luksCreateOptions(options.outputEncryption, outFormat, outputSecretId).join(",")
    );
  }

  if (options.inputEncryption) {
    const inFormat = requireFormatForEncryption(options.inputFormat, "convert");
    args.push(
      "--image-opts",
      encryptedImageOptsSpec(options.input, inFormat, inputSecretId)
    );
  } else {
    args.push(options.input);
  }

  args.push(options.output);
  return args;
}

export function resizeImageArgs(
  options: ResizeImageOptions,
  secretFile?: string
): string[] {
  const args: string[] = ["resize"];
  if (options.encryption) {
    if (!secretFile) {
      throw new InvalidImageConfigError(
        "resizeImageArgs() needs the passphrase already written to a file. " +
          "qemuImg.resize() does that for you."
      );
    }
    args.push(...secretObjectArgs({ id: SECRET_ID, file: secretFile }));
  }

  if (!options.encryption && options.format) args.push("-f", options.format);
  if (options.shrink) args.push("--shrink");

  if (options.encryption) {
    const format = requireFormatForEncryption(options.format, "resize");
    args.push("--image-opts", encryptedImageOptsSpec(options.path, format));
  } else {
    args.push(options.path);
  }

  args.push(options.size);
  return args;
}

export function infoImageArgs(
  path: string,
  options: InfoImageOptions = {},
  secretFile?: string
): string[] {
  const args: string[] = ["info"];
  if (options.encryption) {
    if (!secretFile) {
      throw new InvalidImageConfigError(
        "infoImageArgs() needs the passphrase already written to a file. " +
          "qemuImg.info() does that for you."
      );
    }
    args.push(...secretObjectArgs({ id: SECRET_ID, file: secretFile }));
  }

  args.push("--output=json");

  if (options.encryption) {
    const format = requireFormatForEncryption(options.format, "info");
    args.push("--image-opts", encryptedImageOptsSpec(path, format));
  } else {
    if (options.format) args.push("-f", options.format);
    args.push(path);
  }
  return args;
}

export function checkImageArgs(
  path: string,
  options: CheckImageOptions = {},
  secretFile?: string
): string[] {
  const args: string[] = ["check"];
  if (options.encryption) {
    if (!secretFile) {
      throw new InvalidImageConfigError(
        "checkImageArgs() needs the passphrase already written to a file. " +
          "qemuImg.check() does that for you."
      );
    }
    args.push(...secretObjectArgs({ id: SECRET_ID, file: secretFile }));
  }

  args.push("--output=json");
  if (!options.encryption && options.format) args.push("-f", options.format);
  if (options.repair) args.push("-r", options.repair);

  if (options.encryption) {
    const format = requireFormatForEncryption(options.format, "check");
    args.push("--image-opts", encryptedImageOptsSpec(path, format));
  } else {
    args.push(path);
  }
  return args;
}

// --- stateful helpers ----------------------------------------------------------

async function run(
  args: string[],
  runOptions: QemuRunOptions,
  what: string
): Promise<QemuExitResult> {
  const result = await execQemu("qemu-img", args, {
    timeoutMs: 120_000,
    ...runOptions,
  });
  if (result.code !== 0) {
    throw new QemuCommandError(`${what} failed`, result);
  }
  return result;
}

/** Runs `body` with every passphrase materialized, cleaning up afterwards. */
async function withSecrets<T>(
  sources: (PassphraseSource | undefined)[],
  body: (files: (string | undefined)[]) => Promise<T>
): Promise<T> {
  const materialized: MaterializedSecret[] = [];
  try {
    const files = sources.map((source) => {
      if (!source) return undefined;
      const secret = materializePassphrase(source);
      materialized.push(secret);
      return secret.file;
    });
    return await body(files);
  } finally {
    for (const secret of materialized) secret.cleanup();
  }
}

/**
 * qemu-img exit codes. `check` reports its findings this way rather than by
 * failing, and 63 is how it says "this format has no consistency check" —
 * which still means the image was opened successfully.
 */
const EXIT_OK = 0;
const EXIT_CHECK_UNSUPPORTED = 63;

/** Typed helpers over the vendored `qemu-img` binary. */
export const qemuImg = {
  /** Escape hatch: run qemu-img with raw args. Does not throw on non-zero exit. */
  raw(args: string[], options: QemuRunOptions = {}): Promise<QemuExitResult> {
    return execQemu("qemu-img", args, options);
  },

  async create(
    options: CreateImageOptions,
    runOptions: QemuRunOptions = {}
  ): Promise<void> {
    await withSecrets([options.encryption], async ([secretFile]) => {
      await run(
        createImageArgs(options, secretFile),
        runOptions,
        "qemu-img create"
      );
    });
  },

  async convert(
    options: ConvertImageOptions,
    runOptions: QemuRunOptions = {}
  ): Promise<void> {
    await withSecrets(
      [options.inputEncryption, options.outputEncryption],
      async ([input, output]) => {
        await run(
          convertImageArgs(options, { input, output }),
          runOptions,
          "qemu-img convert"
        );
      }
    );
  },

  async resize(
    options: ResizeImageOptions,
    runOptions: QemuRunOptions = {}
  ): Promise<void> {
    await withSecrets([options.encryption], async ([secretFile]) => {
      await run(
        resizeImageArgs(options, secretFile),
        runOptions,
        "qemu-img resize"
      );
    });
  },

  async info(
    path: string,
    options: InfoImageOptions = {},
    runOptions: QemuRunOptions = {}
  ): Promise<ImageInfo> {
    return withSecrets([options.encryption], async ([secretFile]) => {
      const result = await run(
        infoImageArgs(path, options, secretFile),
        runOptions,
        "qemu-img info"
      );
      const raw = JSON.parse(
        (result.stdout ?? Buffer.alloc(0)).toString("utf8")
      ) as {
        format?: string;
        "virtual-size"?: number;
        "actual-size"?: number;
        encrypted?: boolean;
      };
      return {
        // Keep the caller's path: with --image-opts qemu-img echoes back the
        // whole json: driver spec as the filename, which is not a usable path.
        path,
        format: raw.format,
        virtualSize: raw["virtual-size"],
        actualSize: raw["actual-size"],
        encrypted: raw.encrypted,
        raw,
      };
    });
  },

  /**
   * Checks image consistency. Returns the raw exit result because qemu-img
   * uses non-zero exit codes to describe the kinds of corruption found
   * (1 = check not completed, 2 = corruption, 3 = leaked clusters,
   * 63 = this format has no consistency check).
   */
  check(
    path: string,
    options: CheckImageOptions = {},
    runOptions: QemuRunOptions = {}
  ): Promise<QemuExitResult> {
    return withSecrets([options.encryption], ([secretFile]) =>
      execQemu("qemu-img", checkImageArgs(path, options, secretFile), {
        timeoutMs: 120_000,
        ...runOptions,
      })
    );
  },

  /**
   * Reports whether a passphrase actually unlocks an encrypted image.
   *
   * This runs `qemu-img check`, because opening the image is the only way to
   * find out: `qemu-img info` reads the LUKS header without ever deriving a
   * key and so succeeds with a wrong passphrase. Exit 63 ("no consistency
   * check for this format", which is the case for a bare `luks` container)
   * counts as success — the image still had to be unlocked to get that far.
   *
   * Deriving a key is deliberately slow (that is what `iterTime` buys), so
   * expect this to take roughly as long as booting a VM off the image would.
   */
  async verifyPassphrase(
    path: string,
    format: EncryptableFormat,
    encryption: PassphraseSource,
    runOptions: QemuRunOptions = {}
  ): Promise<boolean> {
    // Not `this.check`: the helper stays correct when destructured off the
    // object, which is a normal way to import it.
    const result = await qemuImg.check(path, { format, encryption }, runOptions);
    return result.code === EXIT_OK || result.code === EXIT_CHECK_UNSUPPORTED;
  },
};
