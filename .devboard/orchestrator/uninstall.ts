import { existsSync, unlinkSync } from "node:fs";
import { SERVICE_NAME, systemctl, unitPaths } from "./systemd";

/**
 * Stops, disables, and removes the user service. It touches no repository
 * file, so an uninstall leaves the harness exactly as it was.
 */

const paths = unitPaths();
systemctl("stop", SERVICE_NAME);
systemctl("disable", SERVICE_NAME);
for (const path of [paths.enableLink, paths.service]) {
  if (!existsSync(path)) continue;
  try {
    unlinkSync(path);
  } catch (error) {
    console.error(
      `orchestrator:uninstall: could not remove ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
const reload = systemctl("daemon-reload");
if (reload.code !== 0) {
  console.error(
    `orchestrator:uninstall: daemon-reload failed: ${reload.stderr || reload.stdout}`,
  );
  process.exit(1);
}
console.log("orchestrator:uninstall: service stopped, disabled, and removed");
