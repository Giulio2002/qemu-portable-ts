import { QemuCommandError } from "./errors";
import { QemuExitResult, QemuRunOptions, execQemu } from "./process";

export type DiskImageFormat = "qcow2" | "raw" | "vmdk" | "vdi" | "vpc";

export interface CreateImageOptions {
  path: string;
  /** Size accepted by qemu-img, e.g. "20G", "512M", or bytes as a string. */
  size: string;
  format?: DiskImageFormat;
  backingFile?: string;
  backingFormat?: DiskImageFormat;
  preallocation?: "off" | "metadata" | "falloc" | "full";
}

export interface ConvertImageOptions {
  input: string;
  output: string;
  inputFormat?: DiskImageFormat;
  outputFormat: DiskImageFormat;
  compressed?: boolean;
}

export interface ResizeImageOptions {
  path: string;
  /** Absolute ("20G") or relative ("+5G") size. */
  size: string;
  format?: DiskImageFormat;
  /** Required to shrink an image; adds --shrink. */
  shrink?: boolean;
}

export interface CheckImageOptions {
  format?: DiskImageFormat;
  repair?: "leaks" | "all";
}

export interface ImageInfo {
  path: string;
  format?: string;
  virtualSize?: number;
  actualSize?: number;
  raw: unknown;
}

// Pure arg builders — unit-testable without any binary installed.

export function createImageArgs(options: CreateImageOptions): string[] {
  const args = ["create", "-f", options.format ?? "qcow2"];
  if (options.backingFile) {
    args.push("-b", options.backingFile);
    if (options.backingFormat) args.push("-F", options.backingFormat);
  }
  if (options.preallocation) {
    args.push("-o", `preallocation=${options.preallocation}`);
  }
  args.push(options.path, options.size);
  return args;
}

export function convertImageArgs(options: ConvertImageOptions): string[] {
  const args = ["convert"];
  if (options.compressed) args.push("-c");
  if (options.inputFormat) args.push("-f", options.inputFormat);
  args.push("-O", options.outputFormat, options.input, options.output);
  return args;
}

export function resizeImageArgs(options: ResizeImageOptions): string[] {
  const args = ["resize"];
  if (options.format) args.push("-f", options.format);
  if (options.shrink) args.push("--shrink");
  args.push(options.path, options.size);
  return args;
}

export function infoImageArgs(
  path: string,
  options: { format?: DiskImageFormat } = {}
): string[] {
  const args = ["info", "--output=json"];
  if (options.format) args.push("-f", options.format);
  args.push(path);
  return args;
}

export function checkImageArgs(
  path: string,
  options: CheckImageOptions = {}
): string[] {
  const args = ["check", "--output=json"];
  if (options.format) args.push("-f", options.format);
  if (options.repair) args.push("-r", options.repair);
  args.push(path);
  return args;
}

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
    await run(createImageArgs(options), runOptions, "qemu-img create");
  },

  async convert(
    options: ConvertImageOptions,
    runOptions: QemuRunOptions = {}
  ): Promise<void> {
    await run(convertImageArgs(options), runOptions, "qemu-img convert");
  },

  async resize(
    options: ResizeImageOptions,
    runOptions: QemuRunOptions = {}
  ): Promise<void> {
    await run(resizeImageArgs(options), runOptions, "qemu-img resize");
  },

  async info(
    path: string,
    options: { format?: DiskImageFormat } = {},
    runOptions: QemuRunOptions = {}
  ): Promise<ImageInfo> {
    const result = await run(
      infoImageArgs(path, options),
      runOptions,
      "qemu-img info"
    );
    const raw = JSON.parse((result.stdout ?? Buffer.alloc(0)).toString("utf8")) as {
      format?: string;
      "virtual-size"?: number;
      "actual-size"?: number;
    };
    return {
      path,
      format: raw.format,
      virtualSize: raw["virtual-size"],
      actualSize: raw["actual-size"],
      raw,
    };
  },

  /**
   * Checks image consistency. Returns the raw exit result because qemu-img
   * uses non-zero exit codes to describe the kinds of corruption found
   * (1 = check not completed, 2 = corruption, 3 = leaked clusters).
   */
  check(
    path: string,
    options: CheckImageOptions = {},
    runOptions: QemuRunOptions = {}
  ): Promise<QemuExitResult> {
    return execQemu("qemu-img", checkImageArgs(path, options), {
      timeoutMs: 120_000,
      ...runOptions,
    });
  },
};
