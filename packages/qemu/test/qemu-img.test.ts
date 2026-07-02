import assert from "node:assert/strict";
import test from "node:test";

import {
  checkImageArgs,
  convertImageArgs,
  createImageArgs,
  infoImageArgs,
  resizeImageArgs,
} from "../src/qemu-img";

test("create args: defaults to qcow2", () => {
  assert.deepEqual(createImageArgs({ path: "disk.qcow2", size: "20G" }), [
    "create", "-f", "qcow2", "disk.qcow2", "20G",
  ]);
});

test("create args: backing file with format and preallocation", () => {
  assert.deepEqual(
    createImageArgs({
      path: "overlay.qcow2",
      size: "20G",
      format: "qcow2",
      backingFile: "base.qcow2",
      backingFormat: "qcow2",
      preallocation: "metadata",
    }),
    [
      "create", "-f", "qcow2",
      "-b", "base.qcow2", "-F", "qcow2",
      "-o", "preallocation=metadata",
      "overlay.qcow2", "20G",
    ]
  );
});

test("convert args: formats and compression", () => {
  assert.deepEqual(
    convertImageArgs({
      input: "in.raw",
      output: "out.qcow2",
      inputFormat: "raw",
      outputFormat: "qcow2",
      compressed: true,
    }),
    ["convert", "-c", "-f", "raw", "-O", "qcow2", "in.raw", "out.qcow2"]
  );
});

test("resize args: grow and shrink", () => {
  assert.deepEqual(resizeImageArgs({ path: "d.qcow2", size: "+5G" }), [
    "resize", "d.qcow2", "+5G",
  ]);
  assert.deepEqual(
    resizeImageArgs({ path: "d.qcow2", size: "10G", format: "qcow2", shrink: true }),
    ["resize", "-f", "qcow2", "--shrink", "d.qcow2", "10G"]
  );
});

test("info args: JSON output with optional format", () => {
  assert.deepEqual(infoImageArgs("d.qcow2"), ["info", "--output=json", "d.qcow2"]);
  assert.deepEqual(infoImageArgs("d.raw", { format: "raw" }), [
    "info", "--output=json", "-f", "raw", "d.raw",
  ]);
});

test("check args: repair modes", () => {
  assert.deepEqual(checkImageArgs("d.qcow2"), ["check", "--output=json", "d.qcow2"]);
  assert.deepEqual(checkImageArgs("d.qcow2", { format: "qcow2", repair: "leaks" }), [
    "check", "--output=json", "-f", "qcow2", "-r", "leaks", "d.qcow2",
  ]);
});
