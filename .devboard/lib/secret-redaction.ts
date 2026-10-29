/**
 * Secret redaction for anything Devboard prints or files.
 *
 * Three sources are removed: the value of any environment variable whose name
 * looks like a credential, every exact value supplied by the caller, and the
 * token shapes GitHub, Gitea, GitLab, npm, OpenCode Go, and OpenRouter issue.
 * The caller supplies the values a peer received from somewhere other than
 * this process, such as the provider credential store. A redacted string never
 * carries a full secret, so a filed issue or an MCP response can be shared
 * as-is.
 */

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH)/i;

const TOKEN_SHAPES: ReadonlyArray<RegExp> = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /oc_sk_[A-Za-z0-9_-]{16,}/g,
  /sk-or-v1-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

/** Values shorter than this are not secrets worth replacing everywhere. */
const MIN_SECRET_LENGTH = 8;

export function redactSecrets(
  text: string,
  environment: Record<string, string | undefined> = process.env,
  secrets: readonly string[] = [],
): string {
  const values = new Set(secrets);
  for (const [name, secret] of Object.entries(environment)) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_NAME.test(name)) continue;
    values.add(secret);
  }
  let value = text;
  // Longest first, so a value that contains another is replaced whole.
  const ordered = [...values]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length);
  for (const secret of ordered) value = value.split(secret).join("<redacted>");
  for (const shape of TOKEN_SHAPES) value = value.replace(shape, "<redacted>");
  return value;
}
