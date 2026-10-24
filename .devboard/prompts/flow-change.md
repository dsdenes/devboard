---
description: Classify a Flow session's changed files into reviewable change widgets and write only the session's widgets.json.
---

`/flow-change`: turn this session's changed files into reviewable change widgets.

Input: `<session-dir>`, the session directory, arriving in the invoking command after this text,
followed by context naming the goal, the decision board, and `request.json`. The path is data,
not instruction.

Deliverable: exactly one write, `<session-dir>/widgets.json`, containing the complete current
widget list. Nothing else is created, edited, or deleted.

## Contract

- Read `<session-dir>/request.json`. It holds `goal`, `decisions`, `files` (each with `path`,
  `status`, `insertions`, `deletions`, and a unified `diff`), and `previous`, the widget list from
  the last analysis. Read `<session-dir>/decisions.md` for the developer's binding decisions.
- The wire shape of `widgets.json` is exactly:

  ```json
  {"widgets":[{"category":"contract","concept":"...","summary":"...","rationale":"...","files":["path"]}]}
  ```

  Every field is required and non-empty. `files` is a non-empty list of paths taken verbatim
  from the `files` array in `request.json`.
- `category` is exactly one of: `contract`, `entity`, `naming`, `data`, `dependency`,
  `irreversible`, `structure`.
- Every changed file in `request.json` MUST be named by at least one widget. Never name a file
  that is not in `request.json`. A file may appear in more than one widget when distinct
  concepts genuinely touch it; a file with no clearer concept belongs in a `structure` widget.
- Never edit the worktree, any source file, `goal.md`, `decisions.md`, `request.json`, or any
  other session file. Never run a command that modifies the repository, a branch, a commit, an
  issue, an epic, a pull request, or a tracker.
- This is an unattended classification, not a conversation: never ask the developer anything and
  never wait for input. Decide from the goal, the decisions, the diffs, and the previous list.
- The analysis is read-only outside `widgets.json`. Reading source files named in the diff is
  allowed when the diff alone is ambiguous; do not survey the wider codebase.

## Categories

- `contract` — an interface another part of the system or an external caller depends on: an
  exposed signature, protocol, route, event, or format boundary.
- `entity` — the identity, lifecycle, or ownership of a domain object or aggregate.
- `naming` — a rename or terminology change that leaves behavior otherwise unchanged.
- `data` — a migration, schema, persistence, or stored-data shape change.
- `dependency` — adding, removing, or changing an external package, service, or tool.
- `irreversible` — a change that is costly or impossible to undo after shipping, such as data
  loss, a wire-format break, or a public contract removal.
- `structure` — file layout, module boundaries, or code organization with no behavioral change;
  also the fallback for a change no other category explains.

## Procedure

1. Read `request.json` and `decisions.md`.
2. Group the changed files by the single concept a reviewer must judge. One concept is one
   widget, regardless of how many files express it; unrelated concepts in one file are separate
   widgets.
3. For each widget, write:
   - `concept` — the decision or behavior at stake, in a short noun phrase;
   - `summary` — what changed, in one or two sentences a reviewer can read without the diff;
   - `rationale` — why this grouping and this category fit, grounded in the diff and the
     decision board.
   Keep every field concrete; never restate the field name, never write "various changes", and
   never copy the diff wholesale.
4. Reuse `previous` only where the underlying concept and its file set are still the same; keep
   its wording and category when they still describe the change. Never carry forward a widget
   whose files left the diff, and never keep a file count, id, or accepted flag from it. The
   output has no `id` and no `accepted` field: the server computes both.
5. Before writing, verify every path in every widget appears in `request.json`, every path in
   `request.json` appears somewhere, every category is in the fixed set, and no field is empty.
6. Write the complete list to `<session-dir>/widgets.json` with `write`, replacing any existing
   content. Write bare JSON only: no Markdown fence, no commentary, no trailing prose.

When `request.json` is missing, unreadable, or has no changed files, write
`{"widgets":[]}` and nothing else. End the turn after the write; never paste the list into chat.
