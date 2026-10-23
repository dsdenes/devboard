---
description: Symlink the ~/devboard harness into this session's working directory and start its UI
argument-hint: "[host path] [--port N] [--force] [--no-ui]"
---

Install Devboard for this session by running the canonical setup script once:

```bash
"$HOME/devboard/.devboard/setup-devboard.sh" $ARGUMENTS
```

With no host path argument the script installs into the session's current working directory.
It makes `.devboard`, `.omp/commands`, and `.omp/extensions` symlinks to `$HOME/devboard` —
it never copies the harness — records `/.devboard`, `/.omp/commands`, and `/.omp/extensions`
in the host `.gitignore`, rebuilds the client, and starts the interface in the background.

Report the final `setup-devboard: interface ...` line verbatim. On a nonzero exit, report the
script's stderr and stop. Do not create, copy, or edit harness or host files yourself; the
script owns the install.
