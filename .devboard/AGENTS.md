# Harness instructions

## Restart the interface after every change

After any change under `.devboard/`, restart the running Devboard interface so the page reflects
the new code. Never leave a stale server serving the previous build.

1. Rebuild the client from `.devboard/`: `bun run build`.
2. Stop the running interface server and start it again with the same host paths it was given —
   `ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`, `PORT`, `AGENT_COMMAND` — so it serves the
   fresh `dist/`.
3. Confirm the restarted server answers on its port before continuing.

This holds for every kind of change, including documentation-only and test-only edits.
