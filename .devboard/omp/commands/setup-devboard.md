---
description: Install or refresh the Devboard harness in this session's working directory
argument-hint: "[host path] [--port N]"
---

Install Devboard for this session by running the launcher once from the host repository:

```bash
npx --yes @dsdenes/devboard@latest install $ARGUMENTS
```

The launcher resolves the newest private harness release, installs it as a real npm prefix at
`<host>/.devboard`, replaces any legacy harness symlinks in `.devboard`, `.omp/commands`, and
`.omp/extensions` with real directories, copies the wrappers and `AGENTS.md`, records the three
ignored paths, and leaves exactly one dashboard running from the installed package. It never
symlinks a host to a canonical checkout.

A running dashboard checks for newer releases by itself and shows a reload control while the
installed version differs from the loaded one. Do not start a second server, restart one by
hand, or copy harness files into the host; use `npx @dsdenes/devboard update` to install a
release without a restart, and the reload control to restart one.

Report the launcher's final `devboard:` line verbatim. On a nonzero exit, report its stderr and
stop. Do not create, copy, or edit harness or host files yourself; the launcher owns the install.
