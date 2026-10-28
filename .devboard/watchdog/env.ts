import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Load `<root>/.env` into the process environment without overriding a value
 * the caller, systemd, or the shell already set.
 *
 * A dashboard started at the host root gets this file from Bun itself. The
 * watchdog runs from the harness directory under systemd, so the checkout's
 * `.env` - where the operator configures `DEVBOARD_GITEA_URL` and
 * `GITEA_TOKEN` - never reached the process; a Gitea origin over SSH then
 * refused every filing. A missing or unreadable file is not an error: the
 * process keeps the environment it already has.
 */
export function loadRootEnvironment(
  root: string,
  environment: Record<string, string | undefined> = process.env,
): void {
  let text: string;
  try {
    text = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (environment[key] === undefined) environment[key] = value;
  }
}
