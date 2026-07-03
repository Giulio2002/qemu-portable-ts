/**
 * Fixture for the kill-on-exit e2e test (not a test file itself): spawns a
 * long-running fake QEMU through the real spawnQemu() path, records its PID,
 * and exits immediately. The parent test then asserts the child was killed
 * by the exit hook rather than orphaned.
 *
 * argv: <platform> <searchPath> <pidFile>
 */
import { writeFileSync } from "node:fs";

import { HostPlatform } from "../src/platform";
import { spawnQemu } from "../src/process";

const [platform, searchPath, pidFile] = process.argv.slice(2);

const proc = spawnQemu("qemu-img", [], {
  resolve: { platform: platform as HostPlatform, searchPaths: [searchPath] },
  stdio: "ignore",
});

writeFileSync(pidFile, String(proc.pid));
// Exit while the fake QEMU is still running; the exit hook must kill it.
process.exit(0);
