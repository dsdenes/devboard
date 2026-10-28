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
  /** `owner/name`, without a leading slash or a trailing `.git`. */
  project: string;
  /** HTTP origin for an HTTP(S) remote; undefined for SSH and scp forms. */
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

function projectFromPath(path: string): string | undefined {
  const segments = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return undefined;
  const project = `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project) ? project : undefined;
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
  let originUrl: string | undefined;
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
      originUrl = parsed.origin;
    }
  }

  const project = projectFromPath(path);
  if (host.length === 0 || project === undefined) return undefined;

  const lower = host.toLowerCase();
  const forced = trimmed(environment.DEVBOARD_FORGE)?.toLowerCase();
  const forge: Forge =
    forced === "github" || forced === "gitlab" || forced === "gitea"
      ? forced
      : lower === "github.com"
        ? "github"
        : lower.includes("gitlab")
          ? "gitlab"
          : "gitea";

  return {
    forge,
    host: lower,
    project,
    ...(originUrl === undefined ? {} : { originUrl }),
  };
}

/**
 * The Gitea HTTP origin for a resolved remote: explicit configuration first,
 * then an HTTP(S) origin. An SSH origin names a different port than the HTTP
 * service, so it is never guessed.
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
