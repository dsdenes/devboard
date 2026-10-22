# Harness instructions

## Every instance is a symlink to the canonical harness

One harness exists per machine: the checkout at `~/devboard`. Every Devboard instance on that
machine MUST be that same harness reached through a symlink, never a copy, clone, or installed
snapshot:

```
<repo root>/.devboard -> $HOME/devboard/.devboard
```

- Never copy the harness into a host, and never vendor it under another path.
- Keep the symlink out of the host's version control: list `/.devboard` in the host's
  `.gitignore`. The shared harness is on disk only; commits and hosts stay portable.
- Fix the harness once in `~/devboard`; every instance sees the change immediately.
- A second copy is a bug: delete it and replace the path with the symlink.

## Restart the interface after every change

After any change under `.devboard/`, restart the running Devboard interface so the page reflects
the new code. Never leave a stale server serving the previous build.

1. Rebuild the client from `.devboard/`: `bun run build`.
2. Stop the running interface server and start it again with the same host paths it was given —
   `ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`, `PORT`, `AGENT_COMMAND` — so it serves the
   fresh `dist/`.
3. Confirm the restarted server answers on its port before continuing.

This holds for every kind of change, including documentation-only and test-only edits.
