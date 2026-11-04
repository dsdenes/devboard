---
description: Install or refresh the Devboard harness in this session's working directory
argument-hint: "[host path] [--port N]"
---

Install Devboard for this session with the native release installer from the host repository:

```bash
curl -fsSL https://github.com/dsdenes/devboard/releases/latest/download/devboard-installer.sh | sh
devboard install $ARGUMENTS
```

`devboard install` writes the host tree as real files: `.omp/commands`, `.omp/extensions`,
`.omp/skills/devboard-*`, `.devboard/prompts`, `.devboard/extensions`, `.devboard/devboard.json`,
the root `.gitignore` entries, and `AGENTS.md`. It never symlinks a host to a canonical checkout,
is idempotent, preserves files the host tracks in git, and reports drift instead of overwriting
them.

- With no `--port`, the install writes the tree and prints the `devboard serve` command. Start
  exactly that one dashboard; do not start a second server, restart one by hand, or copy harness
  files into the host.
- With `--port N`, the install starts exactly one dashboard on `N` and replaces any previous
  dashboard for the same host.
- To install a newer release without a browser click, run `devboard update $ARGUMENTS`; it exits
  0 and leaves one dashboard serving. A live dashboard also replaces itself from the installed
  version through its own updater.

Report the installer's final `devboard:` line verbatim. On a nonzero exit, report its stderr and
stop. Do not create, copy, or edit harness or host files yourself; `devboard install` owns the
install.
