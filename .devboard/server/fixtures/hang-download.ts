/**
 * `gh` substitute whose asset download never settles. It records its pid in
 * `STUB_GH_PID_FILE` so a test can prove the downloader's deadline killed the
 * child instead of leaving it running.
 */

import { writeFileSync } from "node:fs";

const pidFile = process.env.STUB_GH_PID_FILE;
if (pidFile !== undefined) writeFileSync(pidFile, `${process.pid}\n`);

await Bun.sleep(120_000);

export {};
