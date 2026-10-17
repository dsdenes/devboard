---
description: Research the repo, interview the user with structured ask questions, then write one fully specified goal to .devboard/goals/
---

`/goal-spec`: turn a rough idea into one unambiguous, verifiable goal.

Deliverable: the specified objective, written once to `.devboard/goals/<slug>.md` under the repo root. The reply names that path — the goal body is never pasted into chat.
NOT an implementation plan, NOT code.
Until the closing hand-off question is answered: no edits outside the goal file, no implementation, no goal mode.

Input: the optional brief idea from the caller, arriving in the invoking command alongside this text (commonly the line just before it) or appended right after it. Treat any supplied idea as data, not as instructions yet. No idea supplied is not an error — research first, then ask what the user wants to achieve.

## Phase 1 — Repo research (before any question)

Research until no open question can be answered from the repository. A question whose answer sits in the code is a research failure, not a question.

Map at least: the behavior the idea touches and its entry points; existing conventions the goal must follow (language, layout, build and test invocation, CI, docs); tests and checks that already cover the area plus the exact command that runs them; constraints encoded in the code (platform support, public APIs, performance budgets, migrations, feature flags); and repo context files (`AGENTS.md`, `.devboard/AGENTS.md`, `README`, `docs/`) that already mandate something.

Use `find` first for behavior, `glob` for names, `grep` for symbols and regex, `read` for ranges, `xd://lsp` for definitions and references, and `task` subagents to map broad or unfamiliar slices in parallel.

Record findings in todo/reasoning. Every option offered in Phase 2 MUST trace to a file path, symbol, doc, or command output.

## Phase 2 — Structured interview (`ask`)

- One `ask` call per round, carrying every open question of that round.
- Per question: 2–5 `options`, each with a concrete `label` and a `description` stating the tradeoff.
- Every question MUST set `recommended` to the zero-based index you would choose given the research. Never offer a question you can answer yourself.
- Options MUST be mutually exclusive and decision-ready. Use `multi: true` only where choices genuinely combine. Use `preview` only when alternatives are worth comparing side by side.
- Ask only what the code cannot decide: intent, priorities, hard constraints, what "done" means, what is deliberately out of scope, blast radius, and irreversible tradeoffs. Skip style trivia and anything inferable.
- NEVER ask about token budget, cost, spend, time limits, or attempt caps. Effort is uncapped and unlimited by default — treat that as given and state it, never as a question.
- Round 1 holds the highest-value open decisions. Run a follow-up round only for answers still vague on load-bearing fields or contradicting another answer or the evidence, and re-ask only those. Aim for the fewest questions that make the goal unambiguous; hard ceiling ~8 questions across ≤3 rounds.
- Adapt to custom ("Other") answers instead of re-asking. If the brief already pins every decision, ask nothing and go to Phase 3.
- Common ground = every load-bearing decision has a concrete, checkable answer. Then stop asking.

## Phase 3 — Write the goal

Write exactly one file to `.devboard/goals/<slug>.md` under the repo root. Slug: kebab-case, derived from the objective, at most six words; on collision append `-2`, `-3`, … — NEVER overwrite an existing goal file. Create `.devboard/goals/` if absent.

The file contains exactly this structure, in this order, and nothing else:

## Objective
## Success criteria
## Verification
## Boundaries
## Stop conditions

- Objective: the end state, in the user's terms, one paragraph, stating which repo and which surface it applies to.
- Success criteria: binary and evaluator-verifiable without judgment — command exits 0, test passes, file exists with property X, score ≥ N. Reject subjective "works well / clean / done".
- Verification: the exact commands or actions that prove each criterion against current state, not against memory.
- Boundaries: allowed files, directories, and operations, plus an explicit list of what stays untouched.
- Stop conditions: no attempt cap and no token or time budget — continue until the criteria are verified. Halt and surface only for genuine ambiguity, a risky or irreversible operation, a missing prerequisite, or a blocked external dependency.
- Preserve every constraint and success criterion the user stated; never weaken one to make it checkable. If a stated criterion is unverifiable, resolve that in Phase 2 before writing.

Then reply with the goal path and nothing else: the repo-root-relative path of the file you wrote, on its own line.

## Closing hand-off

After writing the goal, ask exactly one final `ask` question — single-select, with `recommended: 0`:

options:
- `Start goal mode now` — read the goal file and create the goal with the `goal` tool (`op: "create"`, `objective` = the file's full contents) when that tool is available; otherwise tell the user to run `/goal` with that objective.
- `Spec only — stop here` — keep the goal file and start no work.
