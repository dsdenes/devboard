import {
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { journalKey } from "./journal";

/**
 * Durable dashboard state for one host repository. The server writes the whole
 * state before it broadcasts any event, and a replacement process restores it,
 * so a graceful stop, a launcher restart, or a SIGKILL loses no state a client
 * has already seen. One file per repository keyed like the journal keeps two
 * repositories that share a harness from reading each other's state.
 */

/** Envelope version. A file with another version is preserved, never read. */
export const STATE_VERSION = 1;

/** Restored activity is bounded to the first of these limits. */
export const ACTIVITY_MAX_ENTRIES = 1000;
export const ACTIVITY_MAX_BYTES = 1024 * 1024;

/** Replaces trimmed lines so the reader knows the log is older than it looks. */
export const ACTIVITY_TRIMMED_MARKER = "Earlier activity was trimmed.";

/** Total serialized state one repository may keep with every activity bound full. */
export const STATE_MAX_BYTES = 32 * 1024 * 1024;

/** The 24-hex repository key that names this repository's state file. */
export const stateKey = journalKey;

export function stateFile(stateDir: string, repoDir: string): string {
  return join(stateDir, "state", `${stateKey(repoDir)}.json`);
}

export type StateLoad =
  | { kind: "missing" }
  /** The file parsed and named this version; `value` is the envelope's state. */
  | { kind: "loaded"; value: unknown }
  /** Unusable bytes; they were preserved aside when the rename succeeded. */
  | { kind: "damaged"; reason: string; preserved: string | undefined };

/** Moves unusable bytes aside so they are never overwritten or deleted. */
function preserve(path: string): string | undefined {
  const aside = `${path}.damaged-${Date.now()}`;
  try {
    renameSync(path, aside);
    return aside;
  } catch {
    return undefined;
  }
}

/** Moves a state file whose contents cannot be used out of the way, unread. */
export function preserveStateFile(path: string): string | undefined {
  return preserve(path);
}

export function readStateFile(path: string): StateLoad {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return {
      kind: "damaged",
      reason: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      preserved: preserve(path),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return {
      kind: "damaged",
      reason: `the state file is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      preserved: preserve(path),
    };
  }

  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    return {
      kind: "damaged",
      reason: "the state file is not a state envelope",
      preserved: preserve(path),
    };
  }

  const version = parsed.version;
  if (version !== STATE_VERSION) {
    return {
      kind: "damaged",
      reason:
        typeof version === "number"
          ? `the state file has unsupported version ${version}`
          : "the state file has no version",
      preserved: preserve(path),
    };
  }

  if (!("state" in parsed)) {
    return {
      kind: "damaged",
      reason: "the state envelope holds no state",
      preserved: preserve(path),
    };
  }
  const value = parsed.state;
  if (typeof value !== "object" || value === null) {
    return {
      kind: "damaged",
      reason: "the state envelope holds no state",
      preserved: preserve(path),
    };
  }

  return { kind: "loaded", value };
}

/**
 * The sibling a staged synchronous write fills before it is renamed over its
 * destination. State writes block the event loop, so one name per process and
 * destination is enough: two of them never overlap.
 */
function temporarySibling(path: string): string {
  return `${path}.${process.pid}.tmp`;
}

/** Orders asynchronous staged writes so no two share a staging path. */
let stagedWriteSequence = 0;

/**
 * A staging path unique to one asynchronous write. Two saves of the same
 * destination can overlap, and a shared staging path would make the first
 * rename publish the second writer's bytes and the second rename fail.
 */
function stagedSibling(path: string): string {
  stagedWriteSequence += 1;
  return `${path}.${process.pid}.${stagedWriteSequence}.tmp`;
}

/**
 * Replaces the state file atomically: the last complete state stays readable at
 * every instant, and a crash during the write leaves the previous state.
 */
export function writeStateFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = temporarySibling(path);
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was never created or is already gone.
    }
    throw error;
  }
}

/**
 * The asynchronous counterpart of `writeStateFile`, for callers already on
 * promises: the same staged write and rename, with the same guarantee that the
 * destination holds either the previous complete text or the new complete text
 * and never a truncated one.
 */
export async function writeFileAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = stagedSibling(path);
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file was never created or is already gone.
    }
    throw error;
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function activityWithinBounds(store: string[]): boolean {
  if (store.length > ACTIVITY_MAX_ENTRIES) return false;
  let bytes = 0;
  for (const line of store) {
    bytes += byteLength(line);
    if (bytes > ACTIVITY_MAX_BYTES) return false;
  }
  return true;
}

/**
 * Keeps the newest activity entries inside the bound and prefixes one marker so
 * the trimmed log never looks complete. The newest entry is always kept, even
 * when it alone exceeds the byte bound.
 */
export function trimActivity(store: string[]): void {
  if (activityWithinBounds(store)) return;

  const markerBytes = byteLength(ACTIVITY_TRIMMED_MARKER);
  const kept: string[] = [];
  let bytes = markerBytes;
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const line = store[index];
    if (line === undefined) continue;
    const size = byteLength(line);
    const entries = kept.length + 2;
    if (kept.length > 0 && (entries > ACTIVITY_MAX_ENTRIES || bytes + size > ACTIVITY_MAX_BYTES)) {
      break;
    }
    kept.unshift(line);
    bytes += size;
  }

  store.splice(0, store.length, ACTIVITY_TRIMMED_MARKER, ...kept);
}

/** Records one activity line, or one streamed delta, inside the activity bound. */
export function appendActivity(store: string[], text: string, append: boolean): void {
  if (append && store.length > 0) {
    store[store.length - 1] += text;
  } else {
    store.push(text);
  }
  trimActivity(store);
}
