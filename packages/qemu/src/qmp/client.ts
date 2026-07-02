import { EventEmitter } from "node:events";
import { Socket, connect } from "node:net";

import { QmpProtocolError } from "../errors";
import {
  QmpEvent,
  QmpFramer,
  QmpGreeting,
  QmpMessage,
  isQmpEvent,
  isQmpGreeting,
  isQmpResponse,
  serializeQmpCommand,
} from "./protocol";

export interface QmpClientOptions {
  /** Path to the local Unix domain socket (or Windows named pipe). */
  socketPath: string;
  /** Applies to connect, greeting, and each execute round-trip. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * Minimal generic QMP client over local IPC.
 *
 * Security: QMP is a privileged control interface. This client only ever
 * dials a local socket path — it deliberately has no host/port options.
 *
 * Events are re-emitted: `client.on("event", (e: QmpEvent) => ...)`.
 */
export class QmpClient extends EventEmitter {
  private readonly options: QmpClientOptions;
  private socket?: Socket;
  private readonly framer = new QmpFramer();
  private greeting?: QmpGreeting;
  private pending: PendingRequest[] = [];
  private closed = false;

  constructor(options: QmpClientOptions) {
    super();
    this.options = options;
  }

  get serverGreeting(): QmpGreeting | undefined {
    return this.greeting;
  }

  /** Connects, waits for the greeting, and negotiates capabilities. */
  async connect(): Promise<void> {
    if (this.socket) {
      throw new QmpProtocolError("QmpClient is already connected.");
    }
    const timeoutMs = this.options.timeoutMs ?? 10_000;

    await new Promise<void>((resolve, reject) => {
      const socket = connect(this.options.socketPath);
      this.socket = socket;

      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new QmpProtocolError(
            `Timed out connecting to QMP socket ${this.options.socketPath} after ${timeoutMs} ms.`
          )
        );
      }, timeoutMs);

      const greetingHandler = (msg: QmpMessage) => {
        if (isQmpGreeting(msg)) {
          clearTimeout(timer);
          this.greeting = msg;
          resolve();
        }
      };

      socket.on("data", (chunk) => {
        let messages: QmpMessage[];
        try {
          messages = this.framer.push(chunk);
        } catch (err) {
          this.failAll(
            new QmpProtocolError(
              `Invalid JSON from QMP server: ${(err as Error).message}`
            )
          );
          return;
        }
        for (const msg of messages) {
          if (!this.greeting) {
            greetingHandler(msg);
          } else {
            this.dispatch(msg);
          }
        }
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        const wrapped = new QmpProtocolError(
          `QMP socket error (${this.options.socketPath}): ${err.message}`
        );
        this.failAll(wrapped);
        reject(wrapped);
      });

      socket.once("close", () => {
        if (!this.closed) {
          this.failAll(new QmpProtocolError("QMP socket closed unexpectedly."));
        }
      });
    });

    await this.execute("qmp_capabilities");
  }

  /**
   * Sends one command and resolves with its `return` value. QMP responds to
   * commands in order on a single connection, so responses are matched FIFO.
   */
  execute<TResult = unknown, TArgs extends object = object>(
    command: string,
    args?: TArgs
  ): Promise<TResult> {
    const socket = this.socket;
    if (!socket || this.closed) {
      return Promise.reject(new QmpProtocolError("QmpClient is not connected."));
    }
    const timeoutMs = this.options.timeoutMs ?? 10_000;

    return new Promise<TResult>((resolve, reject) => {
      const request: PendingRequest = {
        resolve: (value) => resolve(value as TResult),
        reject,
      };
      request.timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== request);
        reject(
          new QmpProtocolError(
            `QMP command "${command}" timed out after ${timeoutMs} ms.`
          )
        );
      }, timeoutMs);
      this.pending.push(request);
      socket.write(
        serializeQmpCommand({ execute: command, arguments: args })
      );
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new QmpProtocolError("QmpClient closed."));
    await new Promise<void>((resolve) => {
      if (!this.socket || this.socket.destroyed) return resolve();
      this.socket.end(() => resolve());
    });
    this.socket?.destroy();
    this.socket = undefined;
  }

  private dispatch(msg: QmpMessage): void {
    if (isQmpEvent(msg)) {
      this.emit("event", msg as QmpEvent);
      return;
    }
    if (isQmpResponse(msg)) {
      const request = this.pending.shift();
      if (!request) return; // response with no outstanding request; ignore
      if (request.timer) clearTimeout(request.timer);
      if (msg.error) {
        request.reject(
          new QmpProtocolError(
            `QMP error ${msg.error.class}: ${msg.error.desc}`,
            msg.error.class
          )
        );
      } else {
        request.resolve(msg.return);
      }
    }
  }

  private failAll(err: Error): void {
    const pending = this.pending;
    this.pending = [];
    for (const request of pending) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(err);
    }
  }
}
