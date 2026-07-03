import { Socket, connect } from "node:net";

import { GuestAgentError } from "../errors";
import { QmpFramer, serializeQmpCommand } from "./protocol";

export interface GuestAgentClientOptions {
  /** Host socket path the guest agent channel is exposed on. */
  socketPath: string;
  /** Per-command round-trip timeout. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Minimal client for the QEMU Guest Agent (QGA).
 *
 * QGA speaks the same newline-delimited JSON as QMP but, unlike QMP, sends no
 * greeting and has no `qmp_capabilities` handshake — you connect and issue
 * `guest-*` commands directly. Responses are correlated by the numeric `id`
 * we stamp on each command (QGA echoes it back).
 */
export class GuestAgentClient {
  private readonly options: GuestAgentClientOptions;
  private socket?: Socket;
  private readonly framer = new QmpFramer();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(options: GuestAgentClientOptions) {
    this.options = options;
  }

  /** Opens the socket. Does not wait for any greeting (QGA sends none). */
  async connect(): Promise<void> {
    if (this.socket) {
      throw new GuestAgentError("GuestAgentClient is already connected.");
    }
    const timeoutMs = this.options.timeoutMs ?? 10_000;

    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.options.socketPath);
      this.socket = socket;

      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new GuestAgentError(
            `Timed out connecting to guest agent socket ${this.options.socketPath} after ${timeoutMs} ms.`
          )
        );
      }, timeoutMs);

      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });

      socket.on("data", (chunk) => {
        let messages;
        try {
          messages = this.framer.push(chunk);
        } catch (err) {
          this.failAll(
            new GuestAgentError(
              `Invalid data from guest agent: ${(err as Error).message}`
            )
          );
          return;
        }
        for (const msg of messages) this.dispatch(msg);
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        const wrapped = new GuestAgentError(
          `Guest agent socket error (${this.options.socketPath}): ${err.message}`
        );
        this.failAll(wrapped);
        reject(wrapped);
      });

      socket.once("close", () => {
        if (!this.closed) {
          this.failAll(new GuestAgentError("Guest agent socket closed unexpectedly."));
        }
      });
    });
  }

  /** Issues a single guest-agent command and resolves with its `return`. */
  execute<TResult = unknown, TArgs extends object = object>(
    command: string,
    args?: TArgs,
    timeoutMs: number = this.options.timeoutMs ?? 10_000
  ): Promise<TResult> {
    const socket = this.socket;
    if (!socket || this.closed) {
      return Promise.reject(new GuestAgentError("GuestAgentClient is not connected."));
    }
    const id = this.nextId++;

    return new Promise<TResult>((resolve, reject) => {
      const request: PendingRequest = {
        resolve: (value) => resolve(value as TResult),
        reject,
      };
      request.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new GuestAgentError(`Guest agent command "${command}" timed out after ${timeoutMs} ms.`)
        );
      }, timeoutMs);
      this.pending.set(id, request);
      socket.write(serializeQmpCommand({ execute: command, arguments: args, id }));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new GuestAgentError("GuestAgentClient closed."));
    await new Promise<void>((resolve) => {
      if (!this.socket || this.socket.destroyed) return resolve();
      this.socket.end(() => resolve());
    });
    this.socket?.destroy();
    this.socket = undefined;
  }

  private dispatch(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const record = msg as { id?: unknown; return?: unknown; error?: { class?: string; desc?: string } };
    const id = typeof record.id === "number" ? record.id : undefined;
    if (id === undefined) return;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    if (request.timer) clearTimeout(request.timer);
    if (record.error) {
      request.reject(
        new GuestAgentError(
          `Guest agent error ${record.error.class ?? "GenericError"}: ${record.error.desc ?? ""}`,
          record.error.class
        )
      );
    } else {
      request.resolve(record.return);
    }
  }

  private failAll(err: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(err);
    }
  }
}

export interface GuestExecOptions {
  /**
   * Interpret a string command with a shell (`<shell> -c "<command>"`) so
   * `&&`, pipes, and redirection work. Default true for string commands;
   * ignored when `command` is an argv array. Default shell: `/bin/sh`.
   */
  shell?: string | false;
  /** Environment entries as "KEY=value" strings passed to the guest process. */
  env?: string[];
  /** Overall timeout for the whole exec (connect + run). Default 60s. */
  timeoutMs?: number;
  /** How often to poll guest-exec-status while the command runs. Default 200ms. */
  pollIntervalMs?: number;
  /** How long to wait for the guest agent to come up before running. Default 30s. */
  readyTimeoutMs?: number;
}

export interface GuestExecResult {
  /** Process exit code, or null if it was terminated by a signal. */
  exitCode: number | null;
  /** Signal number that terminated the process, if any. */
  signal?: number;
  stdout: string;
  stderr: string;
}

interface GuestExecStatus {
  exited: boolean;
  exitcode?: number;
  signal?: number;
  "out-data"?: string;
  "err-data"?: string;
  "out-truncated"?: boolean;
  "err-truncated"?: boolean;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function decodeB64(data: string | undefined): string {
  return data ? Buffer.from(data, "base64").toString("utf8") : "";
}

/** Waits (with retries) until the guest agent answers a ping, or throws. */
async function waitForAgent(client: GuestAgentClient, readyTimeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastError: Error | undefined;
  // guest-sync validates the channel and flushes any stale bytes. Use a short
  // per-attempt timeout so we can retry quickly while the guest boots, rather
  // than blocking on the full command timeout.
  const attemptTimeout = Math.max(500, Math.min(2000, readyTimeoutMs));
  for (let attempt = 0; Date.now() - start < readyTimeoutMs; attempt++) {
    const token = 0x4242_0000 + attempt;
    try {
      const echoed = await client.execute<number>("guest-sync", { id: token }, attemptTimeout);
      if (echoed === token) return;
    } catch (err) {
      lastError = err as Error;
      await delay(300);
    }
  }
  throw new GuestAgentError(
    `Guest agent did not become ready within ${readyTimeoutMs} ms. ` +
      `Is qemu-guest-agent installed and running in the guest?` +
      (lastError ? `\nLast error: ${lastError.message}` : "")
  );
}

/**
 * Runs a command inside the guest via the QEMU Guest Agent and returns its
 * exit code, stdout, and stderr. Requires `qemu-guest-agent` to be installed
 * and running in the guest (and, on many distros, guest-exec to be enabled in
 * the agent config).
 *
 * A string command runs through a shell so `&&`, pipes, and redirection work;
 * pass an argv array to run a binary directly with no shell.
 */
export async function execInGuest(
  socketPath: string,
  command: string | string[],
  options: GuestExecOptions = {}
): Promise<GuestExecResult> {
  const client = new GuestAgentClient({ socketPath, timeoutMs: options.timeoutMs ?? 60_000 });
  await client.connect();
  try {
    await waitForAgent(client, options.readyTimeoutMs ?? 30_000);

    let path: string;
    let argv: string[];
    if (Array.isArray(command)) {
      if (command.length === 0) {
        throw new GuestAgentError("execInGuest: empty argv array.");
      }
      [path, ...argv] = command;
    } else if (options.shell === false) {
      // Treat the whole string as a single program path with no args.
      path = command;
      argv = [];
    } else {
      path = typeof options.shell === "string" ? options.shell : "/bin/sh";
      argv = ["-c", command];
    }

    const started = await client.execute<{ pid: number }>("guest-exec", {
      path,
      arg: argv,
      "capture-output": true,
      ...(options.env ? { env: options.env } : {}),
    });

    const pollIntervalMs = options.pollIntervalMs ?? 200;
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    for (;;) {
      const status = await client.execute<GuestExecStatus>("guest-exec-status", {
        pid: started.pid,
      });
      if (status.exited) {
        return {
          exitCode: typeof status.exitcode === "number" ? status.exitcode : null,
          signal: status.signal,
          stdout: decodeB64(status["out-data"]),
          stderr: decodeB64(status["err-data"]),
        };
      }
      if (Date.now() > deadline) {
        throw new GuestAgentError(
          `Guest command did not finish within the timeout (pid ${started.pid}).`
        );
      }
      await delay(pollIntervalMs);
    }
  } finally {
    await client.close();
  }
}
