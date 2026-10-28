import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  configuredGiteaToken,
  giteaBaseUrl,
  type ForgeRemote,
} from "./forge";

/**
 * The Gitea HTTP API, shared by the release feed, the issue console, Flow, the
 * scout, the watchdog, the release script, and publish verification.
 *
 * Reads of a public repository need no credential; writes use `GITEA_TOKEN`.
 * The instance address comes from configuration or the origin remote, never
 * from a literal in this repository.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GiteaTarget {
  /** HTTP origin, without a trailing slash. */
  baseUrl: string;
  /** `owner/name`. */
  project: string;
  token?: string;
}

export interface GiteaRepository {
  full_name?: unknown;
  private?: unknown;
  permissions?: unknown;
}

export interface GiteaUser {
  login?: unknown;
}

export interface GiteaAsset {
  id?: number;
  name: string;
  size?: number;
  browser_download_url?: string;
}

export interface GiteaReleaseDocument {
  id?: number;
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  assets?: GiteaAsset[];
}

export interface GiteaIssueDocument {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  state: "open" | "closed";
  body: string;
  labels: string[];
}

export interface GiteaPullDocument {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  title: string;
}

export interface GiteaWorkflowRun {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  url?: string;
}

export class GiteaError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GiteaError";
    this.status = status;
  }
}

function required(value: string, name: string): string {
  if (value.trim().length === 0) throw new GiteaError(`${name} is not configured`);
  return value;
}

/** Resolves the API target from explicit arguments, the environment, and the remote. */
export function giteaTarget(options: {
  remote?: ForgeRemote;
  project?: string;
  baseUrl?: string;
  token?: string;
  environment?: Record<string, string | undefined>;
}): GiteaTarget | undefined {
  const environment = options.environment ?? process.env;
  const project = required(options.project ?? options.remote?.project ?? "", "the Gitea repository");
  const baseUrl = required(
    options.baseUrl ?? giteaBaseUrl(options.remote, environment) ?? "",
    "the Gitea address (set DEVBOARD_GITEA_URL)",
  );
  const token = options.token ?? configuredGiteaToken(environment);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    project,
    ...(token === undefined ? {} : { token }),
  };
}

/** `/api/v1` under the configured origin. */
export function apiUrl(target: GiteaTarget, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${target.baseUrl}/api/v1${suffix}`;
}

/** `/repos/<owner>/<name>` with each path segment encoded. */
export function repoPath(target: GiteaTarget): string {
  const segments = target.project.split("/").map(encodeURIComponent);
  return `/repos/${segments.join("/")}`;
}

function headers(target: GiteaTarget, accept = "application/json"): Record<string, string> {
  return {
    Accept: accept,
    ...(target.token === undefined || target.token.length === 0
      ? {}
      : { Authorization: `token ${target.token}` }),
  };
}

function requestInit(target: GiteaTarget, init: RequestInit | undefined, accept?: string): RequestInit {
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  headers.set("Accept", accept ?? "application/json");
  if (target.token !== undefined && target.token.length > 0) {
    headers.set("Authorization", `token ${target.token}`);
  }
  if (init?.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  return {
    ...init,
    method,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  };
}

function messageFromBody(body: string): string {
  const first = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return "no response body";
  try {
    const parsed: unknown = JSON.parse(first);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      const message = parsed.message;
      if (typeof message === "string") return message;
    }
  } catch {
    // The body is not JSON; the bounded first line is the diagnostic.
  }
  return first.length > 300 ? `${first.slice(0, 300)}…` : first;
}

/** One API call; a non-2xx status becomes a GiteaError with the server message. */
export async function giteaRequest(
  target: GiteaTarget,
  path: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
  accept?: string,
): Promise<Response> {
  const response = await fetchImpl(apiUrl(target, path), requestInit(target, init, accept));
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  throw new GiteaError(
    `${init?.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${messageFromBody(body)}`,
    response.status,
  );
}

/** One JSON API call. */
export async function giteaJson<T>(
  target: GiteaTarget,
  path: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const response = await giteaRequest(target, path, init, fetchImpl);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const first = text.trim().split("\n")[0]?.trim() ?? "";
    const snippet = first.length === 0 ? "no output" : first.length > 300 ? `${first.slice(0, 300)}…` : first;
    throw new GiteaError(`${init?.method ?? "GET"} ${path} returned invalid JSON: ${snippet}`);
  }
}

/** The repository document, whose `permissions` object the console probes. */
export async function giteaRepository(
  target: GiteaTarget,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaRepository> {
  return await giteaJson<GiteaRepository>(target, repoPath(target), undefined, fetchImpl);
}

/** The account a token belongs to. */
export async function giteaUser(
  target: GiteaTarget,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const document = await giteaJson<GiteaUser>(target, "/user", undefined, fetchImpl);
  return typeof document.login === "string" ? document.login : "";
}

/** The newest published release, read without a credential on a public repo. */
export async function giteaLatestRelease(
  target: GiteaTarget,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaReleaseDocument> {
  return await giteaJson<GiteaReleaseDocument>(
    target,
    `${repoPath(target)}/releases/latest`,
    undefined,
    fetchImpl,
  );
}

/** One release by tag, or undefined when it does not exist. */
export async function giteaReleaseByTag(
  target: GiteaTarget,
  tag: string,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaReleaseDocument | undefined> {
  try {
    return await giteaJson<GiteaReleaseDocument>(
      target,
      `${repoPath(target)}/releases/tags/${encodeURIComponent(tag)}`,
      undefined,
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof GiteaError && error.status === 404) return undefined;
    throw error;
  }
}

/**
 * One page of releases, newest first. The release script reads every page so
 * the highest published tag is known even when older releases are numerous.
 */
export async function giteaListReleases(
  target: GiteaTarget,
  options: { limit?: number; page?: number } = {},
  fetchImpl: FetchLike = fetch,
): Promise<GiteaReleaseDocument[]> {
  const limit = options.limit ?? 50;
  const page = options.page ?? 1;
  return await giteaJson<GiteaReleaseDocument[]>(
    target,
    `${repoPath(target)}/releases?limit=${limit}&page=${page}`,
    undefined,
    fetchImpl,
  );
}

export interface CreateReleaseInput {
  tag: string;
  title: string;
  notes: string;
}

export async function giteaCreateRelease(
  target: GiteaTarget,
  input: CreateReleaseInput,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaReleaseDocument> {
  return await giteaJson<GiteaReleaseDocument>(
    target,
    `${repoPath(target)}/releases`,
    {
      method: "POST",
      body: JSON.stringify({
        tag_name: input.tag,
        target_commitish: "main",
        name: input.title,
        body: input.notes,
        draft: false,
        prerelease: false,
      }),
    },
    fetchImpl,
  );
}

/** Uploads one release asset; the form field Gitea expects is `attachment`. */
export async function giteaUploadAsset(
  target: GiteaTarget,
  releaseId: number,
  name: string,
  bytes: Uint8Array,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const form = new FormData();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.append("attachment", new Blob([copy]), name);
  await giteaRequest(
    target,
    `${repoPath(target)}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", body: form },
    fetchImpl,
  );
}

/** Downloads one asset into `destination`; a partial file never survives. */
export async function giteaDownloadAsset(
  target: GiteaTarget,
  asset: GiteaAsset,
  destination: string,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const url =
    asset.browser_download_url ??
    (asset.id === undefined
      ? undefined
      : apiUrl(target, `${repoPath(target)}/releases/assets/${asset.id}`));
  if (url === undefined) throw new GiteaError(`release asset ${asset.name} has no address`);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: headers(
        target,
        asset.browser_download_url === undefined ? "application/octet-stream" : "*/*",
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) {
      throw new GiteaError(`release asset download timed out after ${timeoutMs} ms: ${asset.name}`);
    }
    throw error;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GiteaError(
      `downloading ${asset.name} failed (HTTP ${response.status}): ${messageFromBody(body)}`,
      response.status,
    );
  }
  if (response.body === null) throw new GiteaError(`downloading ${asset.name} returned no body`);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await pipeline(
      // DOM and Node expose structurally different ReadableStream types.
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      createWriteStream(destination),
    );
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const label of value) {
    if (typeof label === "string") names.push(label);
    else if (typeof label === "object" && label !== null) {
      const name = (label as { name?: unknown }).name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

function issueFromDocument(value: unknown): GiteaIssueDocument | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.number !== "number" ||
    !Number.isInteger(record.number) ||
    typeof record.title !== "string" ||
    typeof record.html_url !== "string"
  ) {
    return undefined;
  }
  const createdAt =
    typeof record.created_at === "string"
      ? record.created_at
      : typeof record.createdAt === "string"
        ? record.createdAt
        : new Date(0).toISOString();
  return {
    number: record.number,
    title: record.title,
    url: record.html_url,
    createdAt,
    state: record.state === "closed" ? "closed" : "open",
    body: typeof record.body === "string" ? record.body : "",
    labels: labelNames(record.labels),
  };
}

/**
 * Gitea caps one response at its `MAX_RESPONSE_ITEMS` setting (50 by default),
 * whatever larger `limit` a caller asks for. Requesting that cap and paging
 * until a response adds nothing is the only way to see every issue.
 */
const GITEA_PAGE_SIZE = 50;
const GITEA_MAX_PAGES = 100;

/** One issue by number, with its labels and body. */
export async function giteaIssue(
  target: GiteaTarget,
  number: number,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaIssueDocument> {
  const document = await giteaJson<unknown>(
    target,
    `${repoPath(target)}/issues/${number}`,
    undefined,
    fetchImpl,
  );
  const issue = issueFromDocument(document);
  if (issue === undefined) throw new GiteaError("the issue has no number, title, or URL");
  return issue;
}

/** Every issue in the requested state, pull requests excluded. */
export async function giteaListIssues(
  target: GiteaTarget,
  state: "open" | "closed" | "all",
  fetchImpl: FetchLike = fetch,
): Promise<GiteaIssueDocument[]> {
  const issues: GiteaIssueDocument[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= GITEA_MAX_PAGES; page += 1) {
    const document = await giteaJson<unknown>(
      target,
      `${repoPath(target)}/issues?state=${state}&type=issues&limit=${GITEA_PAGE_SIZE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    if (!Array.isArray(document) || document.length === 0) break;
    let added = 0;
    for (const entry of document) {
      const issue = issueFromDocument(entry);
      if (issue === undefined || seen.has(issue.number)) continue;
      seen.add(issue.number);
      issues.push(issue);
      added += 1;
    }
    // A server that ignores the page parameter repeats the first response;
    // treating a page without new issues as the end keeps this loop finite.
    if (added === 0) break;
  }
  return issues.sort((left, right) => left.number - right.number);
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels?: number[];
}

export async function giteaCreateIssue(
  target: GiteaTarget,
  input: CreateIssueInput,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaIssueDocument> {
  const document = await giteaJson<unknown>(
    target,
    `${repoPath(target)}/issues`,
    { method: "POST", body: JSON.stringify(input) },
    fetchImpl,
  );
  const issue = issueFromDocument(document);
  if (issue === undefined) throw new GiteaError("the created issue has no number or URL");
  return issue;
}

export async function giteaCloseIssue(
  target: GiteaTarget,
  number: number,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await giteaRequest(
    target,
    `${repoPath(target)}/issues/${number}`,
    { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
    fetchImpl,
  );
}

export async function giteaCommentIssue(
  target: GiteaTarget,
  number: number,
  body: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await giteaRequest(
    target,
    `${repoPath(target)}/issues/${number}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
    fetchImpl,
  );
}

/** The trailing issue number of an issue URL, or undefined. */
export function issueNumberFromUrl(url: string): number | undefined {
  const match = /\/issues\/(\d+)\/?$/.exec(url.trim());
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export interface GiteaLabel {
  id: number;
  name: string;
}

export async function giteaLabels(
  target: GiteaTarget,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaLabel[]> {
  const labels: GiteaLabel[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= GITEA_MAX_PAGES; page += 1) {
    const document = await giteaJson<unknown>(
      target,
      `${repoPath(target)}/labels?limit=${GITEA_PAGE_SIZE}&page=${page}`,
      undefined,
      fetchImpl,
    );
    if (!Array.isArray(document) || document.length === 0) break;
    let added = 0;
    for (const entry of document) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "number" || typeof record.name !== "string") continue;
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      labels.push({ id: record.id, name: record.name });
      added += 1;
    }
    if (added === 0) break;
  }
  return labels;
}

export async function giteaCreateLabel(
  target: GiteaTarget,
  name: string,
  color: string,
  description: string,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaLabel> {
  const document = await giteaJson<unknown>(
    target,
    `${repoPath(target)}/labels`,
    { method: "POST", body: JSON.stringify({ name, color, description }) },
    fetchImpl,
  );
  if (typeof document !== "object" || document === null) {
    throw new GiteaError("the created label has no id");
  }
  const record = document as Record<string, unknown>;
  if (typeof record.id !== "number" || typeof record.name !== "string") {
    throw new GiteaError("the created label has no id or name");
  }
  return { id: record.id, name: record.name };
}

/** The label id, created when the repository does not have it yet. */
export async function giteaEnsureLabel(
  target: GiteaTarget,
  name: string,
  color: string,
  description: string,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  const existing = (await giteaLabels(target, fetchImpl)).find((label) => label.name === name);
  if (existing !== undefined) return existing.id;
  return (await giteaCreateLabel(target, name, color, description, fetchImpl)).id;
}

/** Gitea marks a draft by the `WIP:` title prefix. */
export const DRAFT_PREFIX = "WIP: ";

export function draftTitle(title: string): string {
  return title.startsWith(DRAFT_PREFIX) ? title : `${DRAFT_PREFIX}${title}`;
}

export function readyTitle(title: string): string {
  return title.startsWith(DRAFT_PREFIX) ? title.slice(DRAFT_PREFIX.length) : title;
}

function pullFromDocument(value: unknown): GiteaPullDocument | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.number !== "number" ||
    typeof record.html_url !== "string" ||
    typeof record.title !== "string"
  ) {
    return undefined;
  }
  const merged = record.merged === true || record.merged_at !== null && record.merged_at !== undefined;
  const state =
    merged === true ? "merged" : record.state === "closed" ? "closed" : "open";
  return {
    number: record.number,
    url: record.html_url,
    state,
    draft: record.title.startsWith(DRAFT_PREFIX),
    title: record.title,
  };
}

export interface CreatePullInput {
  head: string;
  base: string;
  title: string;
  body: string;
}

export async function giteaCreatePull(
  target: GiteaTarget,
  input: CreatePullInput,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaPullDocument> {
  const document = await giteaJson<unknown>(
    target,
    `${repoPath(target)}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        head: input.head,
        base: input.base,
        title: draftTitle(input.title),
        body: input.body,
      }),
    },
    fetchImpl,
  );
  const pull = pullFromDocument(document);
  if (pull === undefined) throw new GiteaError("the created pull request has no number or URL");
  return pull;
}

export async function giteaEditPull(
  target: GiteaTarget,
  number: number,
  input: { title?: string; body?: string },
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await giteaRequest(
    target,
    `${repoPath(target)}/pulls/${number}`,
    { method: "PATCH", body: JSON.stringify(input) },
    fetchImpl,
  );
}

export async function giteaPull(
  target: GiteaTarget,
  number: number,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaPullDocument> {
  const document = await giteaJson<unknown>(
    target,
    `${repoPath(target)}/pulls/${number}`,
    undefined,
    fetchImpl,
  );
  const pull = pullFromDocument(document);
  if (pull === undefined) throw new GiteaError("the pull request has no readable state");
  return pull;
}

/** Merges with a merge commit: never squash, never rebase. */
export async function giteaMergePull(
  target: GiteaTarget,
  number: number,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await giteaRequest(
    target,
    `${repoPath(target)}/pulls/${number}/merge`,
    { method: "POST", body: JSON.stringify({ Do: "merge" }) },
    fetchImpl,
  );
}

export async function giteaDeleteBranch(
  target: GiteaTarget,
  branch: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await giteaRequest(
    target,
    `${repoPath(target)}/branches/${encodeURIComponent(branch)}`,
    { method: "DELETE" },
    fetchImpl,
  );
}

/** Workflow runs whose triggering commit is `headSha`. */
function workflowRunsFrom(document: unknown): GiteaWorkflowRun[] {
  let entries: unknown;
  if (Array.isArray(document)) {
    entries = document;
  } else if (
    typeof document === "object" &&
    document !== null &&
    "workflow_runs" in document
  ) {
    entries = document.workflow_runs;
  } else {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const runs: GiteaWorkflowRun[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.head_sha !== "string") continue;
    runs.push({
      id: record.id,
      headSha: record.head_sha,
      status: typeof record.status === "string" ? record.status : "",
      conclusion: typeof record.conclusion === "string" ? record.conclusion : null,
      ...(typeof record.html_url === "string" ? { url: record.html_url } : {}),
    });
  }
  return runs;
}

/**
 * Workflow runs for one commit. The run-list endpoint needs a credential on
 * the canonical instance; the public task feed answers the same records, so
 * read-only verification works without a token.
 */
export async function giteaWorkflowRuns(
  target: GiteaTarget,
  headSha: string,
  fetchImpl: FetchLike = fetch,
): Promise<GiteaWorkflowRun[]> {
  try {
    const document = await giteaJson<unknown>(
      target,
      `${repoPath(target)}/actions/runs?head_sha=${encodeURIComponent(headSha)}&limit=50`,
      undefined,
      fetchImpl,
    );
    return workflowRunsFrom(document);
  } catch (error) {
    if (!(error instanceof GiteaError) || error.status !== 401) throw error;
    const document = await giteaJson<unknown>(
      target,
      `${repoPath(target)}/actions/tasks?limit=50`,
      undefined,
      fetchImpl,
    );
    return workflowRunsFrom(document);
  }
}
