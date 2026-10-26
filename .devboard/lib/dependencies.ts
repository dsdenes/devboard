/**
 * Dependency names and repository URLs shared by the Discover crawl and the
 * client. A stack entry is free text ("TypeScript", "@babel/parser ^7.29.9"),
 * so both sides derive the same package name before looking up a repository.
 */

/** The package name a stack or dependency entry starts with. */
export function dependencyName(line: string): string {
  const token = line.trim().split(/\s+/)[0] ?? "";
  if (token.length === 0) return "";
  const versionAt = token.lastIndexOf("@");
  return versionAt > 0 ? token.slice(0, versionAt) : token;
}

function webPath(directory: string): string {
  return directory
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * A web URL for a package-manifest repository field, or null when the value
 * names no browsable repository. Accepts the forms npm manifests use:
 * `git+https://…`, `git@host:owner/repo.git`, `ssh://git@host/…`,
 * `git://…`, `github:owner/repo`, and a plain https URL.
 */
export function normalizeRepositoryUrl(raw: string, directory?: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const shorthand = /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(trimmed);
  if (shorthand !== null) {
    return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  }

  let candidate = trimmed.replace(/^git\+/, "");
  const scp = /^git@([^:\s]+):(.+)$/.exec(candidate);
  if (scp !== null) candidate = `https://${scp[1]}/${scp[2]}`;
  candidate = candidate.replace(/^ssh:\/\/git@/, "https://").replace(/^git:\/\//, "https://");

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  const path = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");
  if (path.length === 0) return null;

  const base = `${parsed.origin}/${path}`;
  const subdirectory = directory === undefined ? "" : webPath(directory);
  if (subdirectory.length === 0 || parsed.hostname !== "github.com") return base;
  return `${base}/tree/HEAD/${subdirectory}`;
}
