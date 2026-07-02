/**
 * QMP wire protocol types and message framing.
 *
 * QMP is a line-oriented JSON protocol: the server greets with a
 * `{"QMP": {...}}` object, the client negotiates with `qmp_capabilities`,
 * then exchanges `{"execute": ...}` / `{"return": ...}` pairs. Asynchronous
 * events arrive as objects with an `"event"` key.
 */
import { QmpProtocolError } from "../errors";

export interface QmpGreeting {
  QMP: {
    version: {
      qemu: { major: number; minor: number; micro: number };
      package: string;
    };
    capabilities: string[];
  };
}

export interface QmpCommand<TArgs extends object = object> {
  execute: string;
  arguments?: TArgs;
  id?: string | number;
}

export interface QmpErrorInfo {
  class: string;
  desc: string;
}

export interface QmpResponse<TResult = unknown> {
  return?: TResult;
  error?: QmpErrorInfo;
  id?: string | number;
}

export interface QmpEvent<TData = unknown> {
  event: string;
  data?: TData;
  timestamp: { seconds: number; microseconds: number };
}

export type QmpMessage = QmpGreeting | QmpResponse | QmpEvent;

export function isQmpGreeting(msg: unknown): msg is QmpGreeting {
  return typeof msg === "object" && msg !== null && "QMP" in msg;
}

export function isQmpEvent(msg: unknown): msg is QmpEvent {
  return typeof msg === "object" && msg !== null && "event" in msg;
}

export function isQmpResponse(msg: unknown): msg is QmpResponse {
  return (
    typeof msg === "object" &&
    msg !== null &&
    ("return" in msg || "error" in msg)
  );
}

export interface QmpFramerOptions {
  /**
   * Maximum bytes to buffer for a single not-yet-terminated line. A peer that
   * never sends a newline would otherwise grow this buffer without bound
   * (memory-exhaustion DoS). QMP is treated as an untrusted input source.
   */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Incremental framer for the newline-delimited JSON stream QMP emits.
 * Feed it raw socket chunks; it yields complete parsed messages and
 * buffers partial lines across chunk boundaries.
 */
export class QmpFramer {
  private buffer = "";
  private readonly maxLineBytes: number;

  constructor(options: QmpFramerOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /** Returns all complete messages contained in the stream so far. */
  push(chunk: Buffer | string): QmpMessage[] {
    this.buffer += chunk.toString();
    const messages: QmpMessage[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      messages.push(JSON.parse(line) as QmpMessage);
    }

    // Whatever remains is an unterminated partial line; refuse to buffer an
    // unbounded amount of it.
    if (this.buffer.length > this.maxLineBytes) {
      const seen = this.buffer.length;
      this.buffer = "";
      throw new QmpProtocolError(
        `QMP line exceeded ${this.maxLineBytes} bytes without a newline ` +
          `(buffered ${seen}); refusing to continue. The peer may be ` +
          `malicious or desynchronized.`
      );
    }
    return messages;
  }

  /** Unconsumed partial data (for diagnostics). */
  get pending(): string {
    return this.buffer;
  }
}

export function serializeQmpCommand(command: QmpCommand): string {
  return `${JSON.stringify(command)}\n`;
}
