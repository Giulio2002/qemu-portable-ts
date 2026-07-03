import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GuestAgentError } from "../src/errors";
import { QmpFramer } from "../src/qmp/protocol";
import { execInGuest } from "../src/qmp/guest-agent";

interface MockOptions {
  /** Don't answer guest-sync, to simulate an agent that never comes up. */
  neverSync?: boolean;
  /** Exec result overrides. */
  exitcode?: number;
  stdout?: string;
  stderr?: string;
  /** Capture the guest-exec command the client sent. */
  onExec?: (cmd: { path?: string; arg?: string[]; env?: string[] }) => void;
}

interface MockQga {
  socketPath: string;
  close(): Promise<void>;
  server: Server;
}

// Mock QEMU Guest Agent: newline-delimited JSON, no greeting, echoes `id`.
function startMockQga(options: MockOptions = {}): Promise<MockQga> {
  const socketPath = join(mkdtempSync(join(tmpdir(), "qga-test-")), "qga.sock");
  const server = createServer((socket) => {
    const framer = new QmpFramer();
    socket.on("data", (chunk) => {
      for (const msg of framer.push(chunk)) {
        const cmd = msg as {
          execute?: string;
          id?: unknown;
          arguments?: { id?: number; path?: string; arg?: string[]; env?: string[]; pid?: number };
        };
        const reply = (body: object) =>
          socket.write(JSON.stringify({ ...body, id: cmd.id }) + "\n");

        switch (cmd.execute) {
          case "guest-sync":
            if (options.neverSync) break;
            reply({ return: cmd.arguments?.id });
            break;
          case "guest-exec":
            options.onExec?.(cmd.arguments ?? {});
            reply({ return: { pid: 4242 } });
            break;
          case "guest-exec-status":
            reply({
              return: {
                exited: true,
                exitcode: options.exitcode ?? 0,
                "out-data": Buffer.from(options.stdout ?? "").toString("base64"),
                "err-data": Buffer.from(options.stderr ?? "").toString("base64"),
              },
            });
            break;
          default:
            reply({ error: { class: "CommandNotFound", desc: cmd.execute } });
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      })
    )
  );
}

test("execInGuest runs a shell command and decodes stdout/exit code", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket mock");
  let sent: { path?: string; arg?: string[] } = {};
  const qga = await startMockQga({ stdout: "hello\n", onExec: (c) => (sent = c) });
  try {
    const result = await execInGuest(qga.socketPath, "echo hello && cd /etc", {
      readyTimeoutMs: 3000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "hello\n");
    // String commands go through a shell so && / pipes work.
    assert.equal(sent.path, "/bin/sh");
    assert.deepEqual(sent.arg, ["-c", "echo hello && cd /etc"]);
  } finally {
    await qga.close();
  }
});

test("execInGuest with an argv array runs the binary directly (no shell)", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket mock");
  let sent: { path?: string; arg?: string[] } = {};
  const qga = await startMockQga({ stdout: "x", onExec: (c) => (sent = c) });
  try {
    await execInGuest(qga.socketPath, ["/bin/ls", "-la", "/tmp"], { readyTimeoutMs: 3000 });
    assert.equal(sent.path, "/bin/ls");
    assert.deepEqual(sent.arg, ["-la", "/tmp"]);
  } finally {
    await qga.close();
  }
});

test("execInGuest surfaces non-zero exit code and stderr", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket mock");
  const qga = await startMockQga({ exitcode: 3, stderr: "boom\n" });
  try {
    const result = await execInGuest(qga.socketPath, "false", { readyTimeoutMs: 3000 });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr, "boom\n");
  } finally {
    await qga.close();
  }
});

test("execInGuest throws GuestAgentError if the agent never responds", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket mock");
  const qga = await startMockQga({ neverSync: true });
  try {
    await assert.rejects(
      execInGuest(qga.socketPath, "echo hi", { readyTimeoutMs: 700 }),
      (err: Error) => {
        assert.ok(err instanceof GuestAgentError);
        assert.match(err.message, /did not become ready|qemu-guest-agent/);
        return true;
      }
    );
  } finally {
    await qga.close();
  }
});

test("execInGuest fails cleanly when the socket does not exist", async (t) => {
  if (process.platform === "win32") return t.skip("unix socket mock");
  await assert.rejects(
    execInGuest("/nonexistent/qga.sock", "echo hi", { readyTimeoutMs: 700 }),
    GuestAgentError
  );
});
