---
description: Release the collected unreleased main range via the harness prompt at .devboard/prompts/release-train.md
argument-hint: "[absolute run directory]"
---

Read `.devboard/prompts/release-train.md` (repo-root-relative) and follow it as the instructions for this turn. Do nothing else.

Run directory (required; read its `request.json`, release the range through `bun run publish`, and write `result.json`): $ARGUMENTS
