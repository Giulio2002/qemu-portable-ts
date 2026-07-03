import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { QemuCommandError, QemuTimeoutError } from "./errors";
import { QemuCommandName } from "./platform";
import { ResolveQemuOptions, ResolvedQemuBinary, resolveQemuBinary } from "./resolve";

export interface QemuRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit" | "ignore";
  signal?: AbortSignal;
  /** Kill the process and reject wait() if it runs longer than this. */
  timeoutMs?: number;
  windowsHide?: boolean;
  /** Extra environment merged over process.env and options.env. */
  extraEnv?: NodeJS.ProcessEnv;
  /** Resolver options (platform override, preferSystem, search paths). */
  resolve?: Omit<ResolveQemuOptions, "command">;
  /** Bypass resolution entirely and run this pre-resolved binary (tests, VM API). */
  resolved?: ResolvedQemuBinary;
  /** Do not auto-inject `-L <share/qemu>` for system emulators. */
  noDataDir?: boolean;
}

export interface QemuExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout?: Buffer;
  stderr?: Buffer;
}

export interface QemuProcess {
  child: ChildProcess;
  command: QemuCommandName;
  binaryPath: string;
  args: string[];
  pid?: number;
  wait(): Promise<QemuExitResult>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * One environment-variable addition a self-spawning consumer should apply
 * before exec'ing a vendored binary. `value` is prepended to any existing
 * value of `name` with the platform's path delimiter.
 */
export interface RuntimeEnvAddition {
  name: "LD_LIBRARY_PATH" | "DYLD_FALLBACK_LIBRARY_PATH" | "PATH";
  value: string;
}

/**
 * Returns the environment additions needed to run a vendored binary, as
 * data, for consumers that own their process lifecycle and spawn QEMU
 * themselves instead of going through spawnQemu().
 *
 * The binaries are built self-contained — RPATH `$ORIGIN/../lib` on Linux,
 * `@loader_path/../lib` install names on macOS, DLLs beside the .exe on
 * Windows — and scripts/verify-binary-package.ts enforces that as a release
 * invariant. These variables are a genuine fallback (e.g. dlopen'd modules,
 * binaries whose install names were not rewritten), not a requirement.
 */
export function resolveRuntimeEnv(
  resolved: ResolvedQemuBinary
): RuntimeEnvAddition[] {
  const libDir = join(resolved.packageRoot, "lib");
  const binDir = join(resolved.packageRoot, "bin");

  if (resolved.hostPlatform.startsWith("linux") && existsSync(libDir)) {
    return [{ name: "LD_LIBRARY_PATH", value: libDir }];
  }
  if (resolved.hostPlatform.startsWith("darwin") && existsSync(libDir)) {
    return [{ name: "DYLD_FALLBACK_LIBRARY_PATH", value: libDir }];
  }
  if (resolved.hostPlatform.startsWith("win32")) {
    // DLLs live next to the .exe; the bin dir on PATH covers any
    // delay-loaded libraries.
    return [{ name: "PATH", value: binDir }];
  }
  return [];
}

/**
 * Builds the environment for a vendored QEMU process by applying
 * {@link resolveRuntimeEnv}'s additions over a base environment.
 */
export function buildLibraryEnv(
  resolved: ResolvedQemuBinary,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const { name, value } of resolveRuntimeEnv(resolved)) {
    env[name] = env[name] ? `${value}${delimiter}${env[name]}` : value;
  }
  return env;
}

function wrapChildProcess(
  child: ChildProcess,
  command: QemuCommandName,
  binaryPath: string,
  args: string[],
  timeoutMs?: number
): QemuProcess {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
  }

  const exit = new Promise<QemuExitResult>((resolve, reject) => {
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(
        new QemuCommandError(
          `Failed to start ${command} (${binaryPath}): ${err.message}`,
          { code: null, signal: null }
        )
      );
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result: QemuExitResult = {
        code,
        signal,
        stdout: child.stdout ? Buffer.concat(stdoutChunks) : undefined,
        stderr: child.stderr ? Buffer.concat(stderrChunks) : undefined,
      };
      if (timedOut) {
        reject(
          new QemuTimeoutError(
            `${command} did not exit within ${timeoutMs} ms and was killed.`
          )
        );
      } else {
        resolve(result);
      }
    });
  });
  // wait() is opt-in; avoid unhandled rejection warnings when callers only
  // observe the process through child events.
  exit.catch(() => {});

  return {
    child,
    command,
    binaryPath,
    args,
    pid: child.pid,
    wait: () => exit,
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal ?? "SIGTERM");
    },
  };
}

/**
 * Spawns a QEMU command with args passed strictly as an array — never through
 * a shell. For system emulators, injects `-L <packageRoot>/share/qemu` so the
 * vendored firmware/keymap data is used instead of any host installation.
 */
export function spawnQemu(
  command: QemuCommandName,
  args: string[],
  options: QemuRunOptions = {}
): QemuProcess {
  const resolved = options.resolved ?? resolveQemuBinary(command, options.resolve);

  const firmwareDir = resolved.firmwareDir ?? resolved.qemuDataDir;
  const injectDataDir =
    !options.noDataDir &&
    command.startsWith("qemu-system-") &&
    firmwareDir !== undefined &&
    !args.includes("-L");

  const finalArgs = injectDataDir
    ? ["-L", firmwareDir as string, ...args]
    : [...args];

  const env = buildLibraryEnv(resolved, {
    ...process.env,
    ...options.env,
    ...options.extraEnv,
  });

  const child = spawn(resolved.path, finalArgs, {
    cwd: options.cwd,
    env,
    stdio: options.stdio ?? "pipe",
    shell: false,
    signal: options.signal,
    windowsHide: options.windowsHide ?? true,
  });

  return wrapChildProcess(
    child,
    command,
    resolved.path,
    finalArgs,
    options.timeoutMs
  );
}

/**
 * Runs a short-lived QEMU command to completion and returns its exit result.
 * Does not throw on non-zero exit; callers decide what a failure means.
 */
export async function execQemu(
  command: QemuCommandName,
  args: string[],
  options: QemuRunOptions = {}
): Promise<QemuExitResult> {
  const proc = spawnQemu(command, args, {
    ...options,
    stdio: options.stdio ?? "pipe",
  });
  return proc.wait();
}

/** Like execQemu, but throws QemuCommandError on non-zero exit. */
export async function execQemuOrThrow(
  command: QemuCommandName,
  args: string[],
  options: QemuRunOptions = {}
): Promise<QemuExitResult> {
  const result = await execQemu(command, args, options);
  if (result.code !== 0) {
    throw new QemuCommandError(
      `${command} ${args.join(" ")} failed with exit code ${result.code}`,
      result
    );
  }
  return result;
}
