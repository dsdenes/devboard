/**
 * Secret redaction for anything Devboard prints or files.
 *
 * Two sources are removed: the value of any environment variable whose name
 * looks like a credential, and the token shapes GitHub, Gitea, GitLab, and npm
 * issue. A redacted string never carries a full secret, so a filed issue or an
 * MCP response can be shared as-is.
 */

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH)/i;

const TOKEN_SHAPES: ReadonlyArray<RegExp> = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

export function redactSecrets(
  text: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  let value = text;
  for (const [name, secret] of Object.entries(environment)) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    if (!SECRET_NAME.test(name)) continue;
    value = value.split(secret).join("<redacted>");
  }
  for (const shape of TOKEN_SHAPES) value = value.replace(shape, "<redacted>");
  return value;
}
