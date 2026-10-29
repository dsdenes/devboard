#!/usr/bin/env bun
/**
 * The deterministic publisher for Design System verification. It records the
 * version and commit the worker hands it and fails only when the mode file
 * says so. It never contacts npm or Gitea.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const logPath = process.env.DESIGN_PUBLISH_LOG;
const stubDir = process.env.DESIGN_STUB_DIR;
const version = process.env.DESIGN_RELEASE_VERSION ?? "unknown";
const commit = process.env.DESIGN_RELEASE_COMMIT ?? "unknown";

let mode = "ok";
if (stubDir !== undefined) {
  try {
    mode = readFileSync(join(stubDir, "publish-mode"), "utf8").trim() || "ok";
  } catch {
    mode = "ok";
  }
}

if (logPath !== undefined) appendFileSync(logPath, `${mode} ${version} ${commit}\n`);
if (mode === "fail") {
  console.error("stub publisher: the release failed");
  process.exit(1);
}
process.exit(0);
