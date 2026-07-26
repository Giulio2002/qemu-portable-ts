import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

import { buildQemuSystemArgs } from "../src/args";
import { InvalidImageConfigError, InvalidVmConfigError } from "../src/errors";
import {
  checkImageArgs,
  convertImageArgs,
  createImageArgs,
  encryptedImageOptsSpec,
  infoImageArgs,
  resizeImageArgs,
} from "../src/qemu-img";
import { QemuSystemCommand } from "../src/platform";
import { ResolvedQemuBinary } from "../src/resolve";
import { materializePassphrase, secretObjectArgs } from "../src/secret";
import { createVm } from "../src/vm";

const KEY = "/run/keys/disk";

// --- secret objects ------------------------------------------------------------

test("secret object: passphrase reaches QEMU by file, never on argv", () => {
  assert.deepEqual(secretObjectArgs({ id: "sec0", file: KEY }), [
    "--object",
    "secret,id=sec0,file=/run/keys/disk,format=raw",
  ]);
  assert.deepEqual(secretObjectArgs({ id: "sec0", file: KEY }, "-object"), [
    "-object",
    "secret,id=sec0,file=/run/keys/disk,format=raw",
  ]);
});

test("secret object: commas in the key path are escaped, not injected", () => {
  const [, spec] = secretObjectArgs({ id: "sec0", file: "/keys/a,b" });
  assert.equal(spec, "secret,id=sec0,file=/keys/a,,b,format=raw");
});

test("secret object: rejects ids that could inject options", () => {
  assert.throws(
    () => secretObjectArgs({ id: "sec0,format=base64", file: KEY }),
    InvalidImageConfigError
  );
});

test("materializePassphrase: inline secret written verbatim, 0600, removable", () => {
  const secret = materializePassphrase({ passphrase: "hunter2" });
  // No trailing newline: QEMU takes the file's exact bytes as the passphrase.
  assert.equal(readFileSync(secret.file, "utf8"), "hunter2");
  if (process.platform !== "win32") {
    assert.equal(statSync(secret.file).mode & 0o777, 0o600);
  }
  secret.cleanup();
  assert.throws(() => statSync(secret.file));
});

test("materializePassphrase: a caller's file is used as-is and never deleted", () => {
  const secret = materializePassphrase({ passphraseFile: KEY });
  assert.equal(secret.file, KEY);
  secret.cleanup(); // must not throw despite the path not existing
});

test("materializePassphrase: an empty passphrase is a configuration error", () => {
  assert.throws(
    () => materializePassphrase({ passphrase: "" }),
    InvalidImageConfigError
  );
});

// --- qcow2 tuning --------------------------------------------------------------

test("create args: qcow2 parameters collapse into one -o list", () => {
  assert.deepEqual(
    createImageArgs({
      path: "d.qcow2",
      size: "20G",
      format: "qcow2",
      preallocation: "metadata",
      qcow2: {
        clusterSize: "2M",
        compat: "1.1",
        lazyRefcounts: true,
        extendedL2: false,
        refcountBits: 16,
        compressionType: "zstd",
      },
    }),
    [
      "create", "-f", "qcow2",
      "-o",
      "preallocation=metadata,cluster_size=2M,compat=1.1,lazy_refcounts=on," +
        "extended_l2=off,refcount_bits=16,compression_type=zstd",
      "d.qcow2", "20G",
    ]
  );
});

test("create args: qcow2 parameters on a non-qcow2 format are rejected", () => {
  assert.throws(
    () => createImageArgs({ path: "d.raw", size: "1G", format: "raw", qcow2: { compat: "1.1" } }),
    InvalidImageConfigError
  );
});

// --- LUKS creation -------------------------------------------------------------

test("create args: bare LUKS container takes key options at the top level", () => {
  assert.deepEqual(
    createImageArgs(
      {
        path: "vault.luks",
        size: "10G",
        format: "luks",
        encryption: { passphraseFile: KEY, cipherAlg: "aes-256", iterTime: 2000 },
      },
      KEY
    ),
    [
      "create",
      "--object", "secret,id=sec0,file=/run/keys/disk,format=raw",
      "-f", "luks",
      "-o", "key-secret=sec0,cipher-alg=aes-256,iter-time=2000",
      "vault.luks", "10G",
    ]
  );
});

test("create args: qcow2 namespaces the same options under encrypt.", () => {
  assert.deepEqual(
    createImageArgs(
      {
        path: "enc.qcow2",
        size: "10G",
        format: "qcow2",
        encryption: { passphraseFile: KEY, cipherAlg: "aes-256", hashAlg: "sha256" },
      },
      KEY
    ),
    [
      "create",
      "--object", "secret,id=sec0,file=/run/keys/disk,format=raw",
      "-f", "qcow2",
      "-o", "encrypt.format=luks,encrypt.key-secret=sec0,encrypt.cipher-alg=aes-256," +
        "encrypt.hash-alg=sha256",
      "enc.qcow2", "10G",
    ]
  );
});

test("create args: formats that cannot carry LUKS are rejected", () => {
  assert.throws(
    () =>
      createImageArgs(
        { path: "d.raw", size: "1G", format: "raw", encryption: { passphraseFile: KEY } },
        KEY
      ),
    InvalidImageConfigError
  );
});

test("create args: the pure builder refuses to invent a key file", () => {
  assert.throws(
    () => createImageArgs({ path: "d.qcow2", size: "1G", encryption: { passphrase: "x" } }),
    InvalidImageConfigError
  );
});

test("create args: iterTime must be a non-negative integer", () => {
  assert.throws(
    () =>
      createImageArgs(
        { path: "d.qcow2", size: "1G", encryption: { passphraseFile: KEY, iterTime: -1 } },
        KEY
      ),
    InvalidImageConfigError
  );
});

// --- reading encrypted images --------------------------------------------------

test("image-opts spec: driver, filename and key, with commas escaped", () => {
  assert.equal(
    encryptedImageOptsSpec("/vm/disk.qcow2", "qcow2"),
    "driver=qcow2,file.filename=/vm/disk.qcow2,encrypt.key-secret=sec0"
  );
  assert.equal(
    encryptedImageOptsSpec("/vm/vault.luks", "luks"),
    "driver=luks,file.filename=/vm/vault.luks,key-secret=sec0"
  );
  assert.equal(
    encryptedImageOptsSpec("/vm/a,b.luks", "luks"),
    "driver=luks,file.filename=/vm/a,,b.luks,key-secret=sec0"
  );
});

test("info args: an encrypted image is opened through a driver spec, not -f", () => {
  assert.deepEqual(
    infoImageArgs("enc.qcow2", { format: "qcow2", encryption: { passphraseFile: KEY } }, KEY),
    [
      "info",
      "--object", "secret,id=sec0,file=/run/keys/disk,format=raw",
      "--output=json",
      "--image-opts", "driver=qcow2,file.filename=enc.qcow2,encrypt.key-secret=sec0",
    ]
  );
});

test("check args: repair mode survives the encrypted path", () => {
  assert.deepEqual(
    checkImageArgs(
      "enc.qcow2",
      { format: "qcow2", repair: "leaks", encryption: { passphraseFile: KEY } },
      KEY
    ),
    [
      "check",
      "--object", "secret,id=sec0,file=/run/keys/disk,format=raw",
      "--output=json", "-r", "leaks",
      "--image-opts", "driver=qcow2,file.filename=enc.qcow2,encrypt.key-secret=sec0",
    ]
  );
});

test("resize args: size stays last after the driver spec", () => {
  assert.deepEqual(
    resizeImageArgs(
      { path: "v.luks", size: "+5G", format: "luks", encryption: { passphraseFile: KEY } },
      KEY
    ),
    [
      "resize",
      "--object", "secret,id=sec0,file=/run/keys/disk,format=raw",
      "--image-opts", "driver=luks,file.filename=v.luks,key-secret=sec0",
      "+5G",
    ]
  );
});

test("reading an encrypted image without a stated format is rejected", () => {
  // The format cannot be probed, because probing means opening the image.
  for (const build of [
    () => infoImageArgs("e.qcow2", { encryption: { passphraseFile: KEY } }, KEY),
    () => checkImageArgs("e.qcow2", { encryption: { passphraseFile: KEY } }, KEY),
    () => resizeImageArgs({ path: "e.qcow2", size: "+1G", encryption: { passphraseFile: KEY } }, KEY),
  ]) {
    assert.throws(build, InvalidImageConfigError);
  }
});

// --- convert -------------------------------------------------------------------

test("convert args: encrypted source uses two distinct secret ids", () => {
  assert.deepEqual(
    convertImageArgs(
      {
        input: "enc.qcow2",
        inputFormat: "qcow2",
        output: "out.luks",
        outputFormat: "luks",
        inputEncryption: { passphraseFile: "/keys/old" },
        outputEncryption: { passphraseFile: "/keys/new", iterTime: 100 },
      },
      { input: "/keys/old", output: "/keys/new" }
    ),
    [
      "convert",
      "--object", "secret,id=sec-in,file=/keys/old,format=raw",
      "--object", "secret,id=sec-out,file=/keys/new,format=raw",
      "-O", "luks",
      "-o", "key-secret=sec-out,iter-time=100",
      "--image-opts", "driver=qcow2,file.filename=enc.qcow2,encrypt.key-secret=sec-in",
      "out.luks",
    ]
  );
});

test("convert args: encrypting a plain source keeps -f for the input", () => {
  assert.deepEqual(
    convertImageArgs(
      {
        input: "plain.raw",
        inputFormat: "raw",
        output: "enc.qcow2",
        outputFormat: "qcow2",
        outputEncryption: { passphraseFile: KEY },
      },
      { output: KEY }
    ),
    [
      "convert",
      "--object", "secret,id=sec-out,file=/run/keys/disk,format=raw",
      "-f", "raw",
      "-O", "qcow2",
      "-o", "encrypt.format=luks,encrypt.key-secret=sec-out",
      "plain.raw", "enc.qcow2",
    ]
  );
});

// --- runtime -drive ------------------------------------------------------------

function argsFor(disk: Record<string, unknown>): string[] {
  return buildQemuSystemArgs(
    { target: "x86_64", disks: [disk as never] },
    "linux"
  ).args;
}

test("vm args: encrypted qcow2 disk declares its secret then references it", () => {
  const args = argsFor({
    path: "/vm/enc.qcow2",
    format: "qcow2",
    encryption: { passphraseFile: KEY },
  });
  const at = args.indexOf("-object");
  assert.equal(args[at + 1], "secret,id=sec-disk0,file=/run/keys/disk,format=raw");
  assert.equal(
    args[at + 3],
    "file=/vm/enc.qcow2,format=qcow2,if=virtio,index=0,encrypt.key-secret=sec-disk0"
  );
  // The secret has to exist before the drive that consumes it.
  assert.ok(at < args.indexOf("-drive"));
});

test("vm args: bare LUKS disk uses the un-namespaced key option", () => {
  const args = argsFor({
    path: "/vm/vault.luks",
    format: "luks",
    encryption: { passphraseFile: KEY },
  });
  assert.equal(
    args[args.indexOf("-drive") + 1],
    "file=/vm/vault.luks,format=luks,if=virtio,index=0,key-secret=sec-disk0"
  );
});

test("vm args: each encrypted disk gets its own secret id", () => {
  const args = buildQemuSystemArgs(
    {
      target: "x86_64",
      disks: [
        { path: "a.qcow2", format: "qcow2", encryption: { passphraseFile: "/k/a" } },
        { path: "b.luks", format: "luks", encryption: { passphraseFile: "/k/b" } },
      ],
    },
    "linux"
  ).args;
  assert.ok(args.includes("secret,id=sec-disk0,file=/k/a,format=raw"));
  assert.ok(args.includes("secret,id=sec-disk1,file=/k/b,format=raw"));
  assert.ok(args.some((a) => a.includes("encrypt.key-secret=sec-disk0")));
  assert.ok(args.some((a) => a.includes("key-secret=sec-disk1")));
});

test("vm args: an encrypted disk must state a format that can carry LUKS", () => {
  assert.throws(
    () => argsFor({ path: "d.img", encryption: { passphraseFile: KEY } }),
    InvalidVmConfigError
  );
  assert.throws(
    () => argsFor({ path: "d.raw", format: "raw", encryption: { passphraseFile: KEY } }),
    InvalidVmConfigError
  );
});

test("vm args: unencrypted disks are unchanged", () => {
  const args = argsFor({ path: "/vm/plain.qcow2", format: "qcow2" });
  assert.ok(!args.includes("-object"));
  assert.equal(
    args[args.indexOf("-drive") + 1],
    "file=/vm/plain.qcow2,format=qcow2,if=virtio,index=0"
  );
});

// --- createVm secret provisioning ----------------------------------------------

function fakeResolved(command: QemuSystemCommand): ResolvedQemuBinary {
  return {
    command,
    path: `/fake/bin/${command}`,
    packageName: "qemu-portable-test",
    packageRoot: "/fake",
    hostPlatform: "linux-x64",
    qemuDataDir: "/fake/share/qemu",
  };
}

test("createVm: an inline passphrase becomes a key file, never an argv token", () => {
  const vm = createVm(
    {
      target: "x86_64",
      disks: [{ path: "/vm/enc.qcow2", format: "qcow2", encryption: { passphrase: "hunter2" } }],
    },
    { resolveBinary: fakeResolved }
  );

  const args = vm.build().args;
  assert.ok(
    !args.some((a) => a.includes("hunter2")),
    "the passphrase must never reach argv, which is world-readable via ps"
  );

  const spec = args[args.indexOf("-object") + 1];
  const keyFile = /file=([^,]+)/.exec(spec)?.[1];
  assert.ok(keyFile, "expected a provisioned key file in the secret object");
  assert.equal(readFileSync(keyFile, "utf8"), "hunter2");

  vm.cleanupSecrets();
  assert.throws(() => statSync(keyFile), "cleanupSecrets should delete the key file");
});

test("createVm: a caller-owned passphraseFile is passed through and never deleted", () => {
  const own = materializePassphrase({ passphrase: "mine" });
  const vm = createVm(
    {
      target: "x86_64",
      disks: [{ path: "/vm/v.luks", format: "luks", encryption: { passphraseFile: own.file } }],
    },
    { resolveBinary: fakeResolved }
  );

  assert.ok(vm.build().args.includes(`secret,id=sec-disk0,file=${own.file},format=raw`));
  vm.cleanupSecrets();
  // Still there: cleanup only removes files createVm wrote itself.
  assert.equal(readFileSync(own.file, "utf8"), "mine");
  own.cleanup();
});
