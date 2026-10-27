import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * The systemd user adapter. It is the only part of the orchestrator that
 * writes outside the repository: one service unit and its enable symlink,
 * created by `systemctl --user enable`. Nothing here names a host, a user, or
 * a repository; the installer substitutes every value.
 */

export const SERVICE_NAME = "devboard-orchestrator.service";

export interface UnitPaths {
  directory: string;
  service: string;
  enableLink: string;
}

export function unitPaths(): UnitPaths {
  const directory = join(homedir(), ".config", "systemd", "user");
  return {
    directory,
    service: join(directory, SERVICE_NAME),
    enableLink: join(directory, "default.target.wants", SERVICE_NAME),
  };
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(argv: string[]): CommandResult {
  try {
    const result = Bun.spawnSync({
      cmd: argv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

export function systemctl(...arguments_: string[]): CommandResult {
  return runCommand(["systemctl", "--user", ...arguments_]);
}

/** Refuses a non-`yes` Linger before anything is installed. */
export function requireLinger(): string {
  const result = runCommand(["loginctl", "show-user", userInfo().username, "-p", "Linger"]);
  if (result.code === 0 && /Linger=yes/.test(result.stdout)) return "Linger=yes";
  throw new Error(
    "missing prerequisite: systemd user lingering is off. " +
      `Run 'loginctl enable-linger ${userInfo().username}' and rerun the installer.`,
  );
}

/**
 * Proves the credential store works without an interactive shell: the same
 * `gh` call the orchestrator's agent needs, run inside a transient user unit.
 */
export function requirePushPermission(repository: string): string {
  const result = runCommand([
    "systemd-run",
    "--user",
    "--wait",
    "--pipe",
    "--collect",
    "--quiet",
    "gh",
    "api",
    `repos/${repository}`,
    "--jq",
    ".permissions.push",
  ]);
  if (result.code === 0 && result.stdout.trim() === "true") return "push permission verified";
  const detail =
    [...result.stderr.split("\n"), ...result.stdout.split("\n")]
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? `exit code ${result.code}`;
  throw new Error(
    `missing prerequisite: a transient systemd unit could not read the credential store: ${detail}`,
  );
}

export function renderUnit(source: string, values: Record<string, string>): string {
  let text = readFileSync(source, "utf8");
  for (const [key, value] of Object.entries(values)) {
    text = text.split(`@${key}@`).join(value);
  }
  return text;
}

export function writeUnit(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function uniqueDirectories(paths: Array<string | null | undefined>): string {
  const directories = new Set<string>();
  for (const path of paths) {
    if (path === null || path === undefined || path.length === 0) continue;
    const directory = dirname(path);
    if (directory.length > 0) directories.add(directory);
  }
  for (const fallback of ["/usr/local/bin", "/usr/bin", "/bin"]) directories.add(fallback);
  return [...directories].join(":");
}
