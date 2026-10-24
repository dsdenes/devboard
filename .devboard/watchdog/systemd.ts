import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * The systemd user adapter. It is the only part of the watchdog that writes
 * outside the repository: two unit files and the timer's enable symlink.
 */

export const TIMER_NAME = "devboard-watchdog.timer";
export const SERVICE_NAME = "devboard-watchdog.service";

export interface UnitPaths {
  directory: string;
  service: string;
  timer: string;
  enableLink: string;
}

export function unitPaths(): UnitPaths {
  const directory = join(homedir(), ".config", "systemd", "user");
  return {
    directory,
    service: join(directory, SERVICE_NAME),
    timer: join(directory, TIMER_NAME),
    enableLink: join(directory, "timers.target.wants", TIMER_NAME),
  };
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function systemctl(...arguments_: string[]): CommandResult {
  const result = Bun.spawnSync({
    cmd: ["systemctl", "--user", ...arguments_],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

export function runCommand(argv: string[]): CommandResult {
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

export function uniqueDirectories(paths: Array<string | undefined>): string {
  const directories = new Set<string>();
  for (const path of paths) {
    if (path === undefined || path.length === 0) continue;
    const directory = dirname(path);
    if (directory.length > 0) directories.add(directory);
  }
  for (const fallback of ["/usr/local/bin", "/usr/bin", "/bin"]) directories.add(fallback);
  return [...directories].join(":");
}
