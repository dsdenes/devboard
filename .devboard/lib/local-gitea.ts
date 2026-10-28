/**
 * Loopback Gitea discovery for the harness source checkout.
 *
 * A development machine runs Gitea locally and starts the dashboard from this
 * checkout. The `origin` remote is often SSH, which names no HTTP origin, so
 * without `DEVBOARD_GITEA_URL` every harness-owned Gitea surface would refuse
 * to start. Discovery asks the local listeners which one answers the Gitea API
 * and takes the lowest matching loopback port.
 *
 * Installed hosts never reach this module: the server gates the call on the
 * source-checkout predicate, and the result is only used when no explicit
 * `DEVBOARD_GITEA_URL`/`GITEA_URL` is configured.
 */

import { readFile } from "node:fs/promises";

/**
 * Ports tried when the platform exposes no listener table. Gitea's default is
 * 3000; the rest are common local HTTP mappings.
 */
export const FALLBACK_PORTS = [3000, 3001, 8000, 8080, 8443, 80, 443];

const PROBE_TIMEOUT_MS = 500;

export type LocalFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalGiteaOptions {
  /** Candidate ports; defaults to the local listener table with a fallback. */
  ports?: number[];
  /** Per-probe deadline. */
  timeoutMs?: number;
  /** Injectable transport. */
  fetchImpl?: LocalFetch;
}

/**
 * Every listening TCP port in a `/proc/net/tcp` or `/proc/net/tcp6` table.
 * Fields are `sl local_address rem_address st ...`; state `0A` is LISTEN and
 * the local address carries the port in hexadecimal after the colon.
 */
export function listeningPortsFrom(table: string): number[] {
  const ports = new Set<number>();
  for (const line of table.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== "0A") continue;
    const local = fields[1] ?? "";
    const separator = local.lastIndexOf(":");
    if (separator < 0) continue;
    const port = Number.parseInt(local.slice(separator + 1), 16);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/** Listening ports on this machine, or the documented fallback when unknown. */
export async function localListeningPorts(): Promise<number[]> {
  const ports = new Set<number>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const port of listeningPortsFrom(await readFile(table, "utf8"))) ports.add(port);
    } catch {
      // The platform has no procfs listener table; the fallback covers it.
    }
  }
  return ports.size > 0 ? [...ports].sort((left, right) => left - right) : FALLBACK_PORTS;
}

/** True for the documented Gitea `GET /api/v1/version` reply. */
export function isGiteaVersionDocument(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("version" in value)) return false;
  const version = value.version;
  return typeof version === "string" && version.trim().length > 0;
}

async function probe(
  port: number,
  fetchImpl: LocalFetch,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/version`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
      return undefined;
    }
    return isGiteaVersionDocument(await response.json())
      ? `http://127.0.0.1:${port}`
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lowest loopback port that answers as a Gitea API, or undefined. Probes
 * run concurrently and every failure is silent: discovery never fails startup.
 */
export async function discoverLocalGitea(
  options: LocalGiteaOptions = {},
): Promise<string | undefined> {
  const ports = [...new Set(options.ports ?? (await localListeningPorts()))].sort(
    (left, right) => left - right,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const found = await Promise.all(
    ports.map((port) => probe(port, fetchImpl, timeoutMs)),
  );
  return found.find((value) => value !== undefined);
}
