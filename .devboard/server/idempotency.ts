import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FeedbackRequestError } from "./feedback";
import { journalKey } from "./journal";
import { writeFileAtomically } from "./state";

/**
 * The longest `Idempotency-Key` a client may send. The IETF idempotency-key
 * draft bounds the value at 255 characters, far above any real retry token.
 */
export const MAX_IDEMPOTENCY_KEY = 255;

/** How long a completed operation stays replayable. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Entries kept across restarts; the oldest are dropped first. */
const MAX_ENTRIES = 1000;

const STORE_VERSION = 1;

interface StoredEntry {
  scope: string;
  key: string;
  result: unknown;
  createdAt: number;
}

interface StoredDocument {
  version: number;
  entries: StoredEntry[];
}

/**
 * Validates the client's `Idempotency-Key` header. An absent header means the
 * request carries no retry contract and runs every time; a present one must be
 * an opaque, bounded token. The value is case-sensitive and never interpreted.
 */
export function parseIdempotencyKey(value: string | null): string | null {
  if (value === null) return null;
  const key = value.trim();
  if (key.length === 0) {
    throw new FeedbackRequestError(400, "Idempotency-Key must not be empty.");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY) {
    throw new FeedbackRequestError(
      400,
      `Idempotency-Key is longer than ${MAX_IDEMPOTENCY_KEY} characters.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new FeedbackRequestError(400, "Idempotency-Key must not contain control characters.");
  }
  return key;
}

function entryId(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

export interface IdempotencyStoreOptions {
  stateDir: string;
  repoDir: string;
  /** Injectable clock for the retention window. */
  now?: () => number;
  /** Receives a failed persistence write; defaults to the server's stderr. */
  reportError?: (message: string) => void;
}

/**
 * Remembers what one keyed operation created, so a retried `POST` answers with
 * the original result instead of creating a second resource. A retry after a
 * dashboard replacement reuses the document under `<stateDir>/idempotency/`,
 * and two concurrent requests with one key share the first attempt.
 *
 * The store is a local replay cache, not a distributed lock: it orders retries
 * that reach this dashboard, and the operation itself stays responsible for the
 * resource.
 */
export class IdempotencyStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly reportError: (message: string) => void;
  private readonly entries = new Map<string, StoredEntry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private writes: Promise<void> = Promise.resolve();

  constructor(options: IdempotencyStoreOptions) {
    this.path = join(
      resolve(options.stateDir),
      "idempotency",
      `${journalKey(resolve(options.repoDir))}.json`,
    );
    this.now = options.now ?? Date.now;
    this.reportError =
      options.reportError ?? ((message) => process.stderr.write(`${message}\n`));
    this.load();
  }

  /**
   * Runs `operation` once per `(scope, key)`. A repeated call with the same key
   * returns the first result, and concurrent calls await the same attempt. A
   * failure is not remembered, so a retry after an error runs again.
   */
  async run<T>(scope: string, key: string | null, operation: () => Promise<T>): Promise<T> {
    if (key === null) return await operation();
    const id = entryId(scope, key);
    const settled = this.entries.get(id);
    if (settled !== undefined) return settled.result as T;
    const running = this.pending.get(id);
    if (running !== undefined) return (await running) as T;

    const attempt = operation()
      .then(async (result) => {
        this.entries.set(id, { scope, key, result, createdAt: this.now() });
        this.prune();
        await this.persist();
        return result;
      })
      .finally(() => {
        this.pending.delete(id);
      });
    this.pending.set(id, attempt);
    return await attempt;
  }

  private load(): void {
    let document: StoredDocument;
    try {
      document = JSON.parse(readFileSync(this.path, "utf8")) as StoredDocument;
    } catch {
      return;
    }
    if (
      typeof document !== "object" ||
      document === null ||
      document.version !== STORE_VERSION ||
      !Array.isArray(document.entries)
    ) {
      return;
    }
    const threshold = this.now() - RETENTION_MS;
    for (const entry of document.entries) {
      if (typeof entry !== "object" || entry === null) continue;
      if (typeof entry.scope !== "string" || typeof entry.key !== "string") continue;
      if (typeof entry.createdAt !== "number" || entry.createdAt < threshold) continue;
      this.entries.set(entryId(entry.scope, entry.key), {
        scope: entry.scope,
        key: entry.key,
        result: entry.result,
        createdAt: entry.createdAt,
      });
    }
    this.prune();
  }

  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const newestFirst = [...this.entries.entries()].sort(
      ([, first], [, second]) => second.createdAt - first.createdAt,
    );
    for (const [id] of newestFirst.slice(MAX_ENTRIES)) this.entries.delete(id);
  }

  private persist(): Promise<void> {
    this.writes = this.writes.then(() => this.writeSnapshot());
    return this.writes;
  }

  /**
   * Writes the whole document under one serialized chain, so two concurrent
   * successes never publish a snapshot that omits the other. A failed write is
   * reported and keeps the in-memory replay: the created resource already
   * exists, so failing the request would invite a duplicate.
   */
  private async writeSnapshot(): Promise<void> {
    const document: StoredDocument = {
      version: STORE_VERSION,
      entries: [...this.entries.values()],
    };
    try {
      await writeFileAtomically(this.path, `${JSON.stringify(document, null, 2)}\n`);
    } catch (error) {
      this.reportError(
        `Could not persist the idempotency store: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
