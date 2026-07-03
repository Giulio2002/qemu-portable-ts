import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQemuSystemArgs,
  escapeQemuOptionValue,
  getAccelerationArgs,
  systemCommandForTarget,
} from "../src/args";
import { InvalidVmConfigError } from "../src/errors";

test("systemCommandForTarget maps guest targets to commands", () => {
  assert.equal(systemCommandForTarget("x86_64"), "qemu-system-x86_64");
  assert.equal(systemCommandForTarget("aarch64"), "qemu-system-aarch64");
  assert.equal(systemCommandForTarget("riscv64"), "qemu-system-riscv64");
});

test("escapeQemuOptionValue doubles commas", () => {
  assert.equal(escapeQemuOptionValue("a,b,c"), "a,,b,,c");
  assert.equal(escapeQemuOptionValue("plain"), "plain");
});

test("acceleration auto emits host accelerator with tcg fallback", () => {
  assert.deepEqual(getAccelerationArgs("auto", "linux"), ["-accel", "kvm", "-accel", "tcg"]);
  assert.deepEqual(getAccelerationArgs("auto", "darwin"), ["-accel", "hvf", "-accel", "tcg"]);
  assert.deepEqual(getAccelerationArgs("auto", "win32"), ["-accel", "whpx", "-accel", "tcg"]);
  assert.deepEqual(getAccelerationArgs("auto", "freebsd"), ["-accel", "tcg"]);
});

test("explicit acceleration modes emit exactly one -accel", () => {
  assert.deepEqual(getAccelerationArgs("tcg", "linux"), ["-accel", "tcg"]);
  assert.deepEqual(getAccelerationArgs("kvm", "darwin"), ["-accel", "kvm"]);
  assert.deepEqual(getAccelerationArgs("hvf", "linux"), ["-accel", "hvf"]);
  assert.deepEqual(getAccelerationArgs("whpx", "linux"), ["-accel", "whpx"]);
});

test("buildQemuSystemArgs produces a full auditable argv", () => {
  const { command, args } = buildQemuSystemArgs(
    {
      target: "x86_64",
      name: "dev-vm",
      machine: "q35",
      cpu: "max",
      memory: "2G",
      smp: 2,
      acceleration: "auto",
      display: "none",
      serial: "stdio",
      disks: [{ path: "./disk.qcow2", format: "qcow2", interface: "virtio" }],
      network: {
        type: "user",
        hostForwards: [{ protocol: "tcp", hostPort: 2222, guestPort: 22 }],
      },
    },
    "linux"
  );

  assert.equal(command, "qemu-system-x86_64");
  assert.deepEqual(args, [
    "-name", "dev-vm",
    "-machine", "q35",
    "-cpu", "max",
    "-m", "2G",
    "-smp", "2",
    "-accel", "kvm",
    "-accel", "tcg",
    "-display", "none",
    "-serial", "stdio",
    "-drive", "file=./disk.qcow2,format=qcow2,if=virtio,index=0",
    "-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22",
    "-device", "virtio-net-pci,netdev=net0",
  ]);
});

test("secure defaults: headless display and no NIC", () => {
  const { args } = buildQemuSystemArgs({ target: "aarch64" }, "darwin");
  assert.ok(args.join(" ").includes("-display none"));
  assert.ok(args.join(" ").includes("-nic none"));
});

test("numeric memory becomes mebibytes", () => {
  const { args } = buildQemuSystemArgs({ target: "x86_64", memory: 512 }, "linux");
  const memIndex = args.indexOf("-m");
  assert.equal(args[memIndex + 1], "512M");
});

test("disk paths with commas are escaped and options rendered", () => {
  const { args } = buildQemuSystemArgs(
    {
      target: "x86_64",
      disks: [
        { path: "/tmp/a,b.qcow2", format: "qcow2", readonly: true, snapshot: true },
      ],
    },
    "linux"
  );
  const driveIndex = args.indexOf("-drive");
  assert.equal(
    args[driveIndex + 1],
    "file=/tmp/a,,b.qcow2,format=qcow2,if=virtio,index=0,readonly=on,snapshot=on"
  );
});

test("kernel boot config renders -kernel/-initrd/-append", () => {
  const { args } = buildQemuSystemArgs(
    {
      target: "aarch64",
      kernel: { kernel: "./vmlinuz", initrd: "./initrd.img", append: "console=ttyAMA0" },
    },
    "linux"
  );
  const text = args.join(" ");
  assert.ok(text.includes("-kernel ./vmlinuz"));
  assert.ok(text.includes("-initrd ./initrd.img"));
  assert.ok(text.includes("-append console=ttyAMA0"));
});

test("serial file config renders -serial file:PATH", () => {
  const { args } = buildQemuSystemArgs(
    { target: "x86_64", serial: { file: "/tmp/serial.log" } },
    "linux"
  );
  const serialIndex = args.indexOf("-serial");
  assert.equal(args[serialIndex + 1], "file:/tmp/serial.log");
});

test("qmp config renders a local unix socket server", () => {
  const { args } = buildQemuSystemArgs(
    {
      target: "x86_64",
      qmp: { enabled: true, socketPath: "/tmp/qmp.sock" },
    },
    "linux"
  );
  const qmpIndex = args.indexOf("-qmp");
  assert.equal(args[qmpIndex + 1], "unix:/tmp/qmp.sock,server=on,wait=off");
});

test("qmp enabled without socketPath throws InvalidVmConfigError", () => {
  assert.throws(
    () =>
      buildQemuSystemArgs(
        { target: "x86_64", qmp: { enabled: true } },
        "linux"
      ),
    InvalidVmConfigError
  );
});

test("qmp disabled emits nothing", () => {
  const { args } = buildQemuSystemArgs(
    { target: "x86_64", qmp: { enabled: false } },
    "linux"
  );
  assert.equal(args.indexOf("-qmp"), -1);
});

test("guestAgent config emits the virtio-serial guest agent channel", () => {
  const { args } = buildQemuSystemArgs(
    { target: "x86_64", guestAgent: { socketPath: "/tmp/qga.sock" } },
    "linux"
  );
  const chardevIdx = args.indexOf("-chardev");
  assert.equal(args[chardevIdx + 1], "socket,path=/tmp/qga.sock,server=on,wait=off,id=qga0");
  assert.ok(args.includes("virtio-serial"));
  assert.ok(
    args.includes("virtserialport,chardev=qga0,name=org.qemu.guest_agent.0")
  );
});

test("guestAgent: true without a socket path throws (pure builder needs it explicit)", () => {
  assert.throws(
    () => buildQemuSystemArgs({ target: "x86_64", guestAgent: true }, "linux"),
    InvalidVmConfigError
  );
});

test("guestAgent socket path with commas is escaped", () => {
  const { args } = buildQemuSystemArgs(
    { target: "x86_64", guestAgent: { socketPath: "/tmp/a,b/qga.sock" } },
    "linux"
  );
  const chardevIdx = args.indexOf("-chardev");
  assert.ok(args[chardevIdx + 1].includes("path=/tmp/a,,b/qga.sock"));
});

test("invalid smp throws InvalidVmConfigError", () => {
  assert.throws(
    () => buildQemuSystemArgs({ target: "x86_64", smp: 0 }, "linux"),
    InvalidVmConfigError
  );
  assert.throws(
    () => buildQemuSystemArgs({ target: "x86_64", smp: 1.5 }, "linux"),
    InvalidVmConfigError
  );
});

test("non-integer forward ports throw InvalidVmConfigError", () => {
  assert.throws(
    () =>
      buildQemuSystemArgs(
        {
          target: "x86_64",
          network: {
            type: "user",
            hostForwards: [{ protocol: "tcp", hostPort: 22.5, guestPort: 22 }],
          },
        },
        "linux"
      ),
    InvalidVmConfigError
  );
});

test("out-of-range forward ports throw InvalidVmConfigError", () => {
  for (const ports of [
    { hostPort: 70000, guestPort: 22 },
    { hostPort: 22, guestPort: -1 },
  ]) {
    assert.throws(
      () =>
        buildQemuSystemArgs(
          { target: "x86_64", network: { type: "user", hostForwards: [{ protocol: "tcp", ...ports }] } },
          "linux"
        ),
      InvalidVmConfigError
    );
  }
});

// Regression: a malicious hostAddress/guestAddress must not be able to break
// out of hostfwd= and inject extra -netdev options (e.g. guestfwd=...-cmd:...,
// which would run a command on the host).
test("forward addresses with injection characters are rejected", () => {
  const attempts = [
    { hostAddress: "127.0.0.1,guestfwd=tcp:1.1.1.1:9-cmd:/bin/sh" },
    { hostAddress: "127.0.0.1,restrict=off" },
    { guestAddress: "10.0.2.15,smb=/etc" },
    { hostAddress: "127.0.0.1 -device foo" },
  ];
  for (const attempt of attempts) {
    assert.throws(
      () =>
        buildQemuSystemArgs(
          {
            target: "x86_64",
            network: {
              type: "user",
              hostForwards: [{ protocol: "tcp", hostPort: 2222, guestPort: 22, ...attempt }],
            },
          },
          "linux"
        ),
      (err: Error) => {
        assert.ok(err instanceof InvalidVmConfigError, `expected reject for ${JSON.stringify(attempt)}`);
        return true;
      }
    );
  }
});

test("invalid forward protocol is rejected", () => {
  assert.throws(
    () =>
      buildQemuSystemArgs(
        {
          target: "x86_64",
          network: {
            type: "user",
            hostForwards: [{ protocol: "icmp" as never, hostPort: 2222, guestPort: 22 }],
          },
        },
        "linux"
      ),
    InvalidVmConfigError
  );
});

test("legitimate IPv4/IPv6/empty forward addresses are accepted", () => {
  const { args } = buildQemuSystemArgs(
    {
      target: "x86_64",
      network: {
        type: "user",
        hostForwards: [
          { protocol: "tcp", hostAddress: "127.0.0.1", hostPort: 2222, guestPort: 22 },
          { protocol: "udp", hostAddress: "[::1]", hostPort: 5353, guestAddress: "10.0.2.15", guestPort: 53 },
        ],
      },
    },
    "linux"
  );
  const netdev = args[args.indexOf("-netdev") + 1];
  // No injected option separators survived: exactly the two hostfwd clauses.
  assert.equal(netdev.match(/hostfwd=/g)?.length, 2);
  assert.ok(!netdev.includes("guestfwd"));
  assert.ok(netdev.includes("hostfwd=tcp:127.0.0.1:2222-:22"));
  assert.ok(netdev.includes("hostfwd=udp:[::1]:5353-10.0.2.15:53"));
});

test("extraArgs are appended last as the escape hatch", () => {
  const { args } = buildQemuSystemArgs(
    { target: "x86_64", extraArgs: ["-machine", "help"] },
    "linux"
  );
  assert.deepEqual(args.slice(-2), ["-machine", "help"]);
});

test("cdrom renders -cdrom", () => {
  const { args } = buildQemuSystemArgs(
    { target: "x86_64", cdrom: "./install.iso" },
    "linux"
  );
  const i = args.indexOf("-cdrom");
  assert.equal(args[i + 1], "./install.iso");
});
