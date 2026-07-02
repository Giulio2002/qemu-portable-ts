import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QmpProtocolError } from "../src/errors";
import { QmpClient } from "../src/qmp/client";
import {
  QmpFramer,
  isQmpEvent,
  isQmpGreeting,
  isQmpResponse,
  serializeQmpCommand,
} from "../src/qmp/protocol";

test("QmpFramer reassembles messages split across chunks", () => {
  const framer = new QmpFramer();
  assert.deepEqual(framer.push('{"return":'), []);
  const messages = framer.push(' {}}\r\n{"event": "STOP", "timestamp": {"seconds": 1, "microseconds": 0}}\n');
  assert.equal(messages.length, 2);
  assert.ok(isQmpResponse(messages[0]));
  assert.ok(isQmpEvent(messages[1]));
  assert.equal(framer.pending, "");
});

test("QmpFramer handles multiple messages in one chunk and blank lines", () => {
  const framer = new QmpFramer();
  const messages = framer.push('{"return": {"status": "running"}}\n\n{"return": {}}\n');
  assert.equal(messages.length, 2);
});

test("message type guards discriminate greeting/response/event", () => {
  const greeting = {
    QMP: { version: { qemu: { major: 10, minor: 0, micro: 2 }, package: "" }, capabilities: [] },
  };
  assert.ok(isQmpGreeting(greeting));
  assert.ok(!isQmpResponse(greeting));
  assert.ok(!isQmpEvent(greeting));
});

test("serializeQmpCommand emits newline-terminated JSON", () => {
  const line = serializeQmpCommand({ execute: "query-status" });
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), { execute: "query-status" });
});

interface MockQmpServer {
  server: Server;
  socketPath: string;
  close(): Promise<void>;
}

/** In-process mock QMP server speaking the greeting/capabilities handshake. */
function startMockQmpServer(): Promise<MockQmpServer> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "qmp-test-")), "qmp.sock");
  const greeting = {
    QMP: {
      version: { qemu: { major: 10, minor: 0, micro: 2 }, package: "mock" },
      capabilities: [],
    },
  };

  const server = createServer((socket) => {
    socket.write(JSON.stringify(greeting) + "\r\n");
    const framer = new QmpFramer();
    // Real QEMU echoes the command's `id` back on the response; the mock must
    // do the same or the client (which now correlates by id) ignores replies.
    const reply = (body: object, id: unknown) =>
      socket.write(JSON.stringify(id === undefined ? body : { ...body, id }) + "\r\n");
    socket.on("data", (chunk) => {
      for (const msg of framer.push(chunk)) {
        const cmd = msg as { execute?: string; id?: unknown };
        switch (cmd.execute) {
          case "qmp_capabilities":
            reply({ return: {} }, cmd.id);
            break;
          case "query-status":
            reply({ return: { status: "running", running: true } }, cmd.id);
            break;
          case "system_powerdown":
            reply({ return: {} }, cmd.id);
            socket.write(
              '{"event": "POWERDOWN", "timestamp": {"seconds": 1, "microseconds": 0}}\r\n'
            );
            break;
          default:
            reply(
              {
                error: {
                  class: "CommandNotFound",
                  desc: `The command ${cmd.execute} has not been found`,
                },
              },
              cmd.id
            );
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () =>
      resolve({
        server,
        socketPath,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}

test("QmpClient handshakes, executes commands, and receives events", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket mock not applicable on Windows");
    return;
  }
  const mock = await startMockQmpServer();
  const client = new QmpClient({ socketPath: mock.socketPath, timeoutMs: 5000 });

  try {
    await client.connect();
    assert.equal(client.serverGreeting?.QMP.version.qemu.major, 10);

    const status = await client.execute<{ status: string }>("query-status");
    assert.equal(status.status, "running");

    const eventPromise = new Promise((resolve) =>
      client.once("event", resolve)
    );
    await client.execute("system_powerdown");
    const event = (await eventPromise) as { event: string };
    assert.equal(event.event, "POWERDOWN");
  } finally {
    await client.close();
    await mock.close();
  }
});

test("QmpClient surfaces QMP errors as QmpProtocolError", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket mock not applicable on Windows");
    return;
  }
  const mock = await startMockQmpServer();
  const client = new QmpClient({ socketPath: mock.socketPath, timeoutMs: 5000 });

  try {
    await client.connect();
    await assert.rejects(
      client.execute("no-such-command"),
      (err: Error) => {
        assert.ok(err instanceof QmpProtocolError);
        assert.equal((err as QmpProtocolError).errorClass, "CommandNotFound");
        assert.match(err.message, /CommandNotFound/);
        return true;
      }
    );
  } finally {
    await client.close();
    await mock.close();
  }
});

test("QmpClient rejects execute when not connected", async () => {
  const client = new QmpClient({ socketPath: "/nonexistent.sock" });
  await assert.rejects(client.execute("query-status"), QmpProtocolError);
});

// Regression: responses are correlated by id, so out-of-order replies (or a
// dropped/timed-out earlier request) never mis-match one command's result to
// another command's promise. FIFO positional matching would fail this.
test("QmpClient correlates concurrent commands by id, not arrival order", async (t) => {
  if (process.platform === "win32") {
    t.skip("unix socket mock not applicable on Windows");
    return;
  }
  const socketPath = join(mkdtempSync(join(tmpdir(), "qmp-order-")), "qmp.sock");
  const greeting = {
    QMP: { version: { qemu: { major: 10, minor: 0, micro: 2 }, package: "mock" }, capabilities: [] },
  };
  const server = createServer((socket) => {
    socket.write(JSON.stringify(greeting) + "\r\n");
    const framer = new QmpFramer();
    const buffered: Array<{ execute?: string; id?: unknown }> = [];
    socket.on("data", (chunk) => {
      for (const msg of framer.push(chunk)) {
        const cmd = msg as { execute?: string; id?: unknown };
        if (cmd.execute === "qmp_capabilities") {
          socket.write(JSON.stringify({ return: {}, id: cmd.id }) + "\r\n");
          continue;
        }
        buffered.push(cmd);
        // Once both real commands are in, answer them in REVERSE order.
        if (buffered.length === 2) {
          const [first, second] = buffered;
          socket.write(JSON.stringify({ return: { echo: second.execute }, id: second.id }) + "\r\n");
          socket.write(JSON.stringify({ return: { echo: first.execute }, id: first.id }) + "\r\n");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, () => r()));

  const client = new QmpClient({ socketPath, timeoutMs: 5000 });
  try {
    await client.connect();
    const p1 = client.execute<{ echo: string }>("cmd-one");
    const p2 = client.execute<{ echo: string }>("cmd-two");
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.echo, "cmd-one");
    assert.equal(r2.echo, "cmd-two");
  } finally {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("QmpFramer rejects an unterminated line past the byte cap", () => {
  const framer = new QmpFramer({ maxLineBytes: 100 });
  assert.throws(
    () => framer.push("x".repeat(200)), // no newline -> unbounded buffer risk
    (err: Error) => {
      assert.ok(err instanceof QmpProtocolError);
      assert.match(err.message, /exceeded 100 bytes/);
      return true;
    }
  );
});
