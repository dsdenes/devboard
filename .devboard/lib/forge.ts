/**
 * Forge identity and address resolution shared by every devboard surface.
 *
 * The canonical forge is read from the checkout's `origin` remote, never from
 * a literal in this repository. GitHub and GitLab are recognised by host name;
 * every other git host is treated as a Gitea instance, whose HTTP address comes
 * from the environment or, for an HTTP(S) origin, from the remote itself.
 *
 * Nothing here contains an instance address, an owner, or a token value.
 */

export type Forge = "github" | "gitlab" | "gitea";

export interface ForgeRemote {
  forge: Forge;
  /** Hostname only; no credentials and no port. */
  host: string;
  /**
   * Repository path without a leading slash or a trailing `.git`:
   * `owner/name` for GitHub and Gitea, `group/sub/project` for a GitLab
   * project below a subgroup.
   */
  project: string;
  /**
   * Instance address for an HTTP(S) remote: its origin plus every path segment
   * the repository path sits under, as in `https://host/gitea`. Undefined for
   * SSH and scp forms, whose HTTP service is never guessed.
   */
  originUrl?: string;
}

const GITEA_URL_KEYS = ["DEVBOARD_GITEA_URL", "GITEA_URL"] as const;
const GITEA_TOKEN_KEYS = ["GITEA_TOKEN", "DEVBOARD_GITEA_TOKEN"] as const;

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim().replace(/\/+$/, "");
  return result.length > 0 ? result : undefined;
}

/** The Gitea HTTP origin the environment configures, if any. */
export function configuredGiteaUrl(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const key of GITEA_URL_KEYS) {
    const value = trimmed(environment[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The Gitea token the environment configures, if any. */
export function configuredGiteaToken(
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const key of GITEA_TOKEN_KEYS) {
    const value = trimmed(environment[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

const PROJECT_SEGMENT = /^[A-Za-z0-9_.-]+$/;

function pathSegments(path: string): string[] {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * The repository path a forge addresses. GitHub and Gitea name exactly
 * `owner/name`, so only the final two segments count. A GitLab project lives
 * under a namespace that may carry subgroups, so every segment is the path;
 * dropping them would point every reader at a different project.
 */
export function projectFromPath(path: string, forge: Forge): string | undefined {
  const segments = pathSegments(path);
  if (segments.length < 2) return undefined;
  const kept = forge === "gitlab" ? segments : segments.slice(-2);
  if (!kept.every((segment) => PROJECT_SEGMENT.test(segment))) return undefined;
  return kept.join("/");
}

/**
 * The path prefix an HTTP(S) repository path sits under: the segments that
 * `projectFromPath` does not keep, joined and opened by `/`. Empty when the
 * project owns the whole path, as `https://host/owner/repo.git` does, and for
 * a GitLab project, whose subgroups are part of the project itself.
 */
function instancePrefix(path: string, forge: Forge): string {
  const segments = pathSegments(path);
  const kept = forge === "gitlab" ? segments.length : 2;
  const prefix = segments.slice(0, segments.length - kept);
  return prefix.length === 0 ? "" : `/${prefix.join("/")}`;
}

/** The forge a hostname names. An explicit `DEVBOARD_FORGE` always wins. */
function forgeFromHost(
  host: string,
  environment: Record<string, string | undefined>,
): Forge {
  const lower = host.toLowerCase();
  const forced = trimmed(environment.DEVBOARD_FORGE)?.toLowerCase();
  if (forced === "github" || forced === "gitlab" || forced === "gitea") return forced;
  if (lower === "github.com") return "github";
  return lower.includes("gitlab") ? "gitlab" : "gitea";
}

/**
 * Classifies a git remote. `undefined` for a local path or a remote without a
 * repository path. An explicit `DEVBOARD_FORGE` wins, so a self-hosted GitHub
 * Enterprise or a Gitea host with an unusual name can be pinned.
 */
export function parseForgeRemote(
  remote: string,
  environment: Record<string, string | undefined> = process.env,
): ForgeRemote | undefined {
  const value = remote.trim();
  if (value.length === 0 || value.startsWith("/") || value.startsWith(".")) return undefined;

  let host = "";
  let path = "";
  let httpOrigin: string | undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
  if (scp !== null && !value.includes("://")) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
    host = parsed.hostname;
    path = parsed.pathname;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      httpOrigin = parsed.origin;
    }
  }

  if (host.length === 0) return undefined;
  const forge = forgeFromHost(host, environment);
  const project = projectFromPath(path, forge);
  if (project === undefined) return undefined;

  return {
    forge,
    host: host.toLowerCase(),
    project,
    ...(httpOrigin === undefined
      ? {}
      : { originUrl: `${httpOrigin}${instancePrefix(path, forge)}` }),
  };
}

/**
 * The Gitea instance address for a resolved remote: explicit configuration
 * first, then the HTTP(S) remote's instance address, which keeps any path
 * prefix the clone URL carries. An SSH origin names a different port than the
 * HTTP service, so it is never guessed.
 */
export function giteaBaseUrl(
  remote: ForgeRemote | undefined,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = configuredGiteaUrl(environment);
  if (configured !== undefined) return configured;
  if (remote !== undefined && remote.forge === "gitea") return remote.originUrl;
  return undefined;
}

/** The synthetic token used by a public forge with no configured credential. */
export const PUBLIC_FORGE_TOKEN = "";

export { GITEA_TOKEN_KEYS, GITEA_URL_KEYS };
