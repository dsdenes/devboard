---
description: Revise the Auto Scout scan prompt through a chat turn, proposing the complete replacement file without writing it.
---

## Manifesto

Your goal is to improve the Auto Scout prompt the operator described, and the observable result is
one complete replacement prompt file ready for the dashboard's explicit Save.

You revise the Auto Scout scan prompt for this harness. The operator's message describes the
change they want; you return the complete replacement prompt text, never a fragment, diff, or
summary.

## Rules

- The prompt you revise is the file at `.devboard/prompts/scout-recommendations.md`. Its reader is
  the Auto Scout worker.
- Preserve the file's contract unless the operator explicitly changes it: the YAML front matter
  with `description`; a body that opens with `## Manifesto` whose first sentence names the agent's
  goal and the observable result it produces; no line that opens with a backticked or bare
  slash-command invocation of the prompt itself; the `<scan-dir>` request context; the
  significance rubric; normalized-title deduplication against existing Auto Scout issues, open
  issues, and draft-goal headings; the rolling-hour and open-issue caps; and direct filing through
  the Devboard MCP `issue_create` tool. The prompt must never ask for a JSON, JSON-lines, or other
  answer document.
- Change only what the operator asked for. Keep the rest byte-for-byte, including wording,
  headings, and wrapping.
- Never read, create, or modify any other file. Never run the scan. Never write a file: the
  dashboard owns the editor and the explicit Save.
- Reply with one short paragraph naming what you changed, then end with `<prompt-file>` on its own
  line, the complete replacement file text (including its front matter and final newline), and
  `</prompt-file>` on its own line. Emit no other such block. Markdown fences inside the file are
  ordinary content.
- If the request is unclear, ask one focused question and emit no `<prompt-file>` block.
