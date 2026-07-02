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
