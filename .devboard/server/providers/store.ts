import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isProviderId, type ProviderId } from "./catalog";

/**
 * The operator's provider credentials. They live outside the dashboard's
 * durable state, in a directory the cleanup never sweeps, so a restart, a
 * cleanup, or a watchdog pass cannot lose them. The whole file is replaced
 * atomically; the directory is 0700 and the file 0600.
 */

export const CREDENTIALS_VERSION = 1;

export interface StoredSubscription {
  id: string;
  provider: ProviderId;
  label: string;
  /** The API key. Never leaves this module except as a selection's env. */
  key: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CredentialsEnvelope {
  version: number;
  subscriptions: StoredSubscription[];
}

export interface LoadedCredentials {
  subscriptions: StoredSubscription[];
  /** A path moved aside because its bytes were unusable, when that happened. */
  preserved: string | undefined;
}

export function providersDirectory(stateDir: string): string {
  return join(stateDir, "providers");
}

export function credentialsPath(stateDir: string): string {
  return join(providersDirectory(stateDir), "credentials.json");
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A pre-existing directory may have wider permissions; the store fixes it.
  chmodSync(directory, 0o700);
}

/** True only for an object shaped like a subscription this version can use. */
function storedSubscription(value: unknown): StoredSubscription | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (!isProviderId(record.provider)) return undefined;
  if (typeof record.label !== "string") return undefined;
  if (typeof record.key !== "string" || record.key.length === 0) return undefined;
  if (typeof record.enabled !== "boolean") return undefined;
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return undefined;
  return {
    id: record.id,
    provider: record.provider,
    label: record.label,
    key: record.key,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function preserve(path: string): string | undefined {
  const aside = `${path}.damaged-${Date.now()}`;
  try {
    renameSync(path, aside);
    return aside;
  } catch {
    return undefined;
  }
}

/**
 * Reads the subscription list. A missing file is an empty list; unusable bytes
 * are moved aside so a later save never overwrites them unnoticed.
 */
export function loadSubscriptions(stateDir: string): LoadedCredentials {
  const path = credentialsPath(stateDir);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { subscriptions: [], preserved: undefined };
    }
    return { subscriptions: [], preserved: preserve(path) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return { subscriptions: [], preserved: preserve(path) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { subscriptions: [], preserved: preserve(path) };
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== CREDENTIALS_VERSION || !Array.isArray(envelope.subscriptions)) {
    return { subscriptions: [], preserved: preserve(path) };
  }
  const subscriptions = envelope.subscriptions
    .map(storedSubscription)
    .filter((entry): entry is StoredSubscription => entry !== undefined);
  return { subscriptions, preserved: undefined };
}

/** Replaces the whole credentials file atomically. */
export function saveSubscriptions(stateDir: string, subscriptions: StoredSubscription[]): void {
  const directory = providersDirectory(stateDir);
  ensureDirectory(directory);
  const path = credentialsPath(stateDir);
  const envelope: CredentialsEnvelope = {
    version: CREDENTIALS_VERSION,
    subscriptions,
  };
  const temporary = join(
    directory,
    `credentials.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file was never created or is already gone.
    }
    throw error;
  }
}

/** A display mask that reveals at most the last four characters. */
export function maskKey(key: string): string {
  if (key.length === 0) return "";
  if (key.length <= 8) return "••••";
  return `••••${key.slice(-4)}`;
}
