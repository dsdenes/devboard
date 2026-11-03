import { readFileSync, readlinkSync, realpathSync } from "node:fs";

/**
 * Process identity and termination for the ACP children a dashboard records.
 * A recorded child is proven by its pid, its command line, and its working
 * directory before anything signals it, so a pid the system reused is never
 * mistaken for the peer this dashboard started.
 *
 * The durable state module stores a `RecordedChild` as data; nothing here reads
 * or writes that file.
 */

/**
 * The canonical path a process table entry reports for a working directory.
 * A path that no longer resolves is compared exactly as recorded.
 */
export function canonicalProcessPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** One ACP child recorded in the state so a replacement can prove and end it. */
export interface RecordedChild {
  pid: number;
  argv: string[];
  cwd: string;
}

/** True only when the pid still runs exactly the recorded command in the recorded cwd. */
export function recordedChildAlive(child: RecordedChild): boolean {
  try {
    process.kill(child.pid, 0);
  } catch {
    return false;
  }
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
  } catch {
    // Without proof from the process table the child is left alone.
    return false;
  }
  const argv = cmdline.split("\u0000").filter((entry) => entry.length > 0);
  if (argv.length !== child.argv.length) return false;
  for (const [index, entry] of child.argv.entries()) {
    if (argv[index] !== entry) return false;
  }
  try {
    return readlinkSync(`/proc/${child.pid}/cwd`) === canonicalProcessPath(child.cwd);
  } catch {
    return false;
  }
}

/**
 * Ends every recorded child whose process table entry proves it is the peer the
 * killed process left behind, and waits until it is gone. A pid that cannot be
 * proven is never signalled.
 */
export async function terminateRecordedChildren(
  children: RecordedChild[],
  timeoutMs = 5000,
): Promise<RecordedChild[]> {
  const proven = children.filter((child) => recordedChildAlive(child));
  for (const child of proven) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // It exited between the check and the signal.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && proven.some((child) => recordedChildAlive(child))) {
    await Bun.sleep(20);
  }
  return proven;
}
