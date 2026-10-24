import { existsSync, unlinkSync } from "node:fs";
import { systemctl, unitPaths } from "./systemd";

/**
 * Stops and removes the user timer. It touches no repository file, so an
 * uninstall leaves the harness exactly as it was.
 */

const paths = unitPaths();
systemctl("stop", "devboard-watchdog.timer");
systemctl("stop", "devboard-watchdog.service");
systemctl("disable", "devboard-watchdog.timer");
for (const path of [paths.service, paths.timer, paths.enableLink]) {
  if (!existsSync(path)) continue;
  try {
    unlinkSync(path);
  } catch (error) {
    console.error(
      `watchdog:uninstall: could not remove ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
const reload = systemctl("daemon-reload");
if (reload.code !== 0) {
  console.error(`watchdog:uninstall: daemon-reload failed: ${reload.stderr || reload.stdout}`);
  process.exit(1);
}
console.log("watchdog:uninstall: timer stopped, disabled, and removed");
