---
description: Resolve the forge host, project, and token scope through the harness forge-auth wrapper, never by enumerating the environment or reading credential files.
---

## Manifesto

Your goal is to use the forge identity this checkout is authorized for, and the observable result
is every tracker read and write authenticated through the harness `forge-auth` wrapper with the
correct scope.

## Program path

`devboard` is a path, not a name. Resolve it once per session, before the first `forge-auth`
invocation, from the `harnessDirectory` the `devboard_status` result names. The harness installs at
the fixed path `<REPO_DIR>/.devboard`, and the candidates under that directory are, in order:

1. `<harnessDirectory>/bin/devboard`, when that file is executable — the installed layout;
2. otherwise the newer, by modification time, of `<harnessDirectory>/target/release/devboard` and
   `<harnessDirectory>/target/debug/devboard` — a source checkout's builds, where a stale build can
   predate the `forge-auth` subcommand and the newest one is the build the harness runs.

`<devboard>` in this file stands for that one absolute path, and it is the only program form for
both `check` and `exec`: resolve it once, reuse it for the rest of the session, and never resolve it
twice. Never a bare `devboard`, never a `PATH="<dir>:$PATH"` prefix, and never a `cd <dir> &&`
prefix. A dashboard-spawned peer inherits a PATH with no harness directory on it, so the bare name
exits 127 and burns the one auth invocation a session allows. When neither candidate exists, stop
and report the missing harness binary as the blocker instead of falling back to the bare name.

Only the program path is absolute: every argument rule below stays as written, so
`<devboard> forge-auth check --required <read|write> --json` is still the canonical invocation.

# Forge identity

`<devboard> forge-auth check` is the single authority for the forge host, the project path, the
base URL, and the token scope a run may use. It reads `DEVBOARD_GITEA_URL`, `GITEA_TOKEN`, and the
`origin` remote itself, so no other file or command has to locate them.

Run it once from the checkout root before the first tracker read or write, in this form when the
target is this checkout's own repository:

```sh
<devboard> forge-auth check --required <read|write> --json
```

That is the canonical invocation, with `<devboard>` the absolute path resolved above: the wrapper
takes `forge`, `host`, and `project` from the `origin` remote — and on Gitea the HTTP origin from
`DEVBOARD_GITEA_URL` — so a prompt passes nothing it resolves itself. A prompt that gates a
specific access level pins only its `--required` value, for example `--required write --json`.

- `<forge>` is `github`, `gitlab`, or `gitea`; the wrapper infers it from the remote's host name.
- Pass an explicit target only when the target repository is not this checkout's `origin`:
  `<devboard> forge-auth check --host <host> --project <owner>/<repo> --required <read|write>
  --json`.
- `--forge` is the last resort for a host name that cannot decide the forge. Never pass it to
  confirm a guess, never combine it with `--host`/`--project` when the origin already names the
  target, and never retry a failed check with a different flag set.
- The exit status is the verdict: zero selects a credential that satisfies `--required`, nonzero
  reports that none does. Never treat stderr as optional and never retry another flag set to make
  a failure pass.

The JSON result carries `forge`, `host`, `project`, `login`, `source`, `active`, `permission`, and
`canWrite`. Those fields are the run's entire knowledge of the forge: no further probe is needed.
When the session context already contains that JSON with `canWrite: true`, the precondition is
resolved: use it as-is and skip the check. Run the check at most once per session, and only when
the context carries no such result.

When a prompt needs the token inside a child process, it names
`<devboard> forge-auth exec ... -- <command>`; that `exec` uses the same resolved path as the
`check`, so one session resolves the binary once. The wrapper injects the selected token into that
child's environment only, never into an argument, a log line, or a reply.

## Forbidden

Never enumerate the process environment or hunt for credential files to discover forge
configuration. In particular, do not:

- run `env`, `printenv`, or `set`, or pipe any of them through `grep` for `gitea`, `forge`,
  `token`, `github`, or `gitlab`;
- read `.env`, `.devboard/.env`, `.devboard/config.json`, `.devboard/.issue-*.json`, `~/.npmrc`,
  or any other configuration or scratch file looking for a token, a base URL, or a repository
  path the wrapper resolves;
- scan `git config` remotes, credential helpers, or environment dumps for forge secrets, and do
  not re-derive the host or project with `sed`, `awk`, or `grep` when the wrapper's own target
  inference answers the same question;
- probe a credential the check did not select: no hand-built API call, no direct `gh` or `glab`
  login check, no token from one forge tested against another host.

## Masking

No captured output may contain a token value. When a prompt must show that a variable exists,
render it as `<set>`; when it must show a redacted value, use `<redacted>`. Never echo a token,
never interpolate one into a URL or a command whose output could print it, and never widen a
prefix of the value "to prove" it is present.

## No credentials

When the check exits nonzero, report its message and the forge it names, then stop probing. Do
not retry with another host, project, forge, or account, and do not search for the credential by
hand. A run that needs write access and has none halts instead of reading configuration.
