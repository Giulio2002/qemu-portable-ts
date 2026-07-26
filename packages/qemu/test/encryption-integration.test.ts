import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { checkHostSupport } from "../src/features";
import { qemuImg } from "../src/qemu-img";

// These tests drive the real vendored qemu-img. They are skipped wherever the
// platform package is absent (a placeholder registry package, or a checkout
// that never ran the binary build) so the suite stays green on any host.
const support = checkHostSupport();
const hasQemuImg = support.ok && support.availableCommands.includes("qemu-img");
const skip = hasQemuImg
  ? false
  : `qemu-img is not available on this host (${support.reason ?? "not installed"})`;

const work = mkdtempSync(join(tmpdir(), "qemu-luks-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

const PASSPHRASE = "correct-horse-battery-staple";
const WRONG = "incorrect-horse-battery-staple";

// A tiny PBKDF cost keeps key derivation from dominating the suite. Real
// images should leave iterTime at QEMU's default.
const FAST = { iterTime: 10 } as const;

test("luks: create a bare container and unlock it with the right passphrase", { skip }, async () => {
  const path = join(work, "vault.luks");
  await qemuImg.create({
    path,
    size: "16M",
    format: "luks",
    encryption: { passphrase: PASSPHRASE, ...FAST },
  });

  assert.equal(
    await qemuImg.verifyPassphrase(path, "luks", { passphrase: PASSPHRASE }),
    true
  );
  assert.equal(
    await qemuImg.verifyPassphrase(path, "luks", { passphrase: WRONG }),
    false
  );

  const info = await qemuImg.info(path);
  assert.equal(info.format, "luks");
  assert.equal(info.encrypted, true);
});

test("qcow2: LUKS-encrypted clusters, with cluster size applied", { skip }, async () => {
  const path = join(work, "enc.qcow2");
  await qemuImg.create({
    path,
    size: "32M",
    format: "qcow2",
    qcow2: { clusterSize: "128k", lazyRefcounts: true },
    encryption: { passphrase: PASSPHRASE, cipherAlg: "aes-256", ...FAST },
  });

  assert.equal(
    await qemuImg.verifyPassphrase(path, "qcow2", { passphrase: PASSPHRASE }),
    true
  );
  assert.equal(
    await qemuImg.verifyPassphrase(path, "qcow2", { passphrase: WRONG }),
    false
  );

  const info = await qemuImg.info(path, {
    format: "qcow2",
    encryption: { passphrase: PASSPHRASE },
  });
  assert.equal(info.format, "qcow2");
  assert.equal(info.encrypted, true);
  assert.equal((info.raw as { "cluster-size"?: number })["cluster-size"], 131072);
});

test("a trailing newline in the key file is part of the passphrase", { skip }, async () => {
  // The most common way to get "Invalid password, cannot unlock any keyslot"
  // with an otherwise correct setup: `echo pass > key` appends a newline.
  const path = join(work, "newline.luks");
  await qemuImg.create({
    path,
    size: "16M",
    format: "luks",
    encryption: { passphrase: PASSPHRASE, ...FAST },
  });

  const exact = join(work, "key-exact");
  const withNewline = join(work, "key-newline");
  writeFileSync(exact, PASSPHRASE);
  writeFileSync(withNewline, `${PASSPHRASE}\n`);

  assert.equal(
    await qemuImg.verifyPassphrase(path, "luks", { passphraseFile: exact }),
    true
  );
  assert.equal(
    await qemuImg.verifyPassphrase(path, "luks", { passphraseFile: withNewline }),
    false
  );
});

test("info alone never proves a passphrase is right", { skip }, async () => {
  // qemu-img info reads the LUKS header without deriving a key, so it happily
  // succeeds under a wrong passphrase. verifyPassphrase exists because of this.
  const path = join(work, "headeronly.luks");
  await qemuImg.create({
    path,
    size: "16M",
    format: "luks",
    encryption: { passphrase: PASSPHRASE, ...FAST },
  });

  const info = await qemuImg.info(path, {
    format: "luks",
    encryption: { passphrase: WRONG },
  });
  assert.equal(info.encrypted, true);
  assert.equal(
    await qemuImg.verifyPassphrase(path, "luks", { passphrase: WRONG }),
    false
  );
});

test("convert: encrypt a plain image, then read it back through its key", { skip }, async () => {
  const plain = join(work, "plain.raw");
  const encrypted = join(work, "converted.qcow2");
  await qemuImg.create({ path: plain, size: "16M", format: "raw" });

  await qemuImg.convert({
    input: plain,
    inputFormat: "raw",
    output: encrypted,
    outputFormat: "qcow2",
    outputEncryption: { passphrase: PASSPHRASE, ...FAST },
  });

  assert.equal(
    await qemuImg.verifyPassphrase(encrypted, "qcow2", { passphrase: PASSPHRASE }),
    true
  );

  // ...and back out again, decrypting through the source key.
  const roundTripped = join(work, "roundtrip.raw");
  await qemuImg.convert({
    input: encrypted,
    inputFormat: "qcow2",
    output: roundTripped,
    outputFormat: "raw",
    inputEncryption: { passphrase: PASSPHRASE },
  });
  const info = await qemuImg.info(roundTripped);
  assert.equal(info.virtualSize, 16 * 1024 * 1024);
});

test("resize: an encrypted image grows through its key", { skip }, async () => {
  const path = join(work, "grow.qcow2");
  await qemuImg.create({
    path,
    size: "16M",
    format: "qcow2",
    encryption: { passphrase: PASSPHRASE, ...FAST },
  });

  await qemuImg.resize({
    path,
    size: "+16M",
    format: "qcow2",
    encryption: { passphrase: PASSPHRASE },
  });

  const info = await qemuImg.info(path, {
    format: "qcow2",
    encryption: { passphrase: PASSPHRASE },
  });
  assert.equal(info.virtualSize, 32 * 1024 * 1024);
});

test("a wrong passphrase fails the operation rather than corrupting output", { skip }, async () => {
  const path = join(work, "locked.luks");
  await qemuImg.create({
    path,
    size: "16M",
    format: "luks",
    encryption: { passphrase: PASSPHRASE, ...FAST },
  });

  await assert.rejects(
    qemuImg.convert({
      input: path,
      inputFormat: "luks",
      output: join(work, "should-not-exist.raw"),
      outputFormat: "raw",
      inputEncryption: { passphrase: WRONG },
    }),
    /Invalid password|cannot unlock/i
  );
});

test("an encrypted overlay over a plain base image", { skip }, async () => {
  // The supported way to combine backing files with encryption: a shared,
  // read-only base in the clear, and every guest's writes in an encrypted
  // overlay. The reverse (an overlay over an *encrypted* base) cannot be
  // opened by qemu-img at all — there is no syntax to key the backing node.
  const base = join(work, "base-plain.qcow2");
  const overlay = join(work, "enc-overlay.qcow2");
  await qemuImg.create({ path: base, size: "32M", format: "qcow2" });

  await qemuImg.create({
    path: overlay,
    size: "32M",
    format: "qcow2",
    backingFile: base,
    backingFormat: "qcow2",
    encryption: { passphrase: PASSPHRASE, ...FAST },
  });

  assert.equal(
    await qemuImg.verifyPassphrase(overlay, "qcow2", { passphrase: PASSPHRASE }),
    true
  );
  assert.equal(
    await qemuImg.verifyPassphrase(overlay, "qcow2", { passphrase: WRONG }),
    false
  );

  const info = await qemuImg.info(overlay, {
    format: "qcow2",
    encryption: { passphrase: PASSPHRASE },
  });
  assert.equal(info.encrypted, true);
  assert.equal((info.raw as { "backing-filename"?: string })["backing-filename"], base);
});
