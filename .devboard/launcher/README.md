# @dsdenes/devboard

Public launcher for the private `@dsdenes/devboard-harness` package. The
launcher holds bootstrap code only; the harness tarball carries the dashboard
server, client bundle, prompts, and omp wrappers and is distributed from GitHub
Releases, never from a registry.

```bash
npx @dsdenes/devboard install   # install or refresh the harness for this host
npx @dsdenes/devboard update    # install the newest release without restarting
npx @dsdenes/devboard doctor    # print one PASS or FAIL line per check
```

`install` writes a real npm prefix at `<host>/.devboard`, replaces harness
symlinks, copies the omp wrappers and `AGENTS.md` template, adds the ignored
paths to `<host>/.gitignore`, and leaves exactly one dashboard running from the
installed package. A reinstall keeps `.devboard/.tmp` and reuses a dashboard
that is already current.

`update` and every running dashboard read the newest private release through
the authenticated `gh` CLI, verify its `.sha256`, install it into the existing
prefix, and never expose a token. A dashboard installs without restarting and
shows its reload control until someone clicks it; `update` never touches the
dashboard.

`doctor` needs Node 20 or newer, Bun, npm, git, an authenticated `gh` account
that can read the release repository, `omp`, and a working install. It reports
wrapper drift, a stale or missing install, a symlinked `.devboard`, a missing
dashboard, and a recorded update failure, and exits nonzero when any check
fails.

`--host <path>` targets a host other than the git root of the current
directory. `DEVBOARD_RELEASE_DIR` points the launcher at a local directory of
release tarballs for offline verification; production runs leave it unset.
