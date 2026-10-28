---
description: Survey the host repository and write the significant, evidence-backed improvement recommendations Auto Scout files as issues.
---

`/scout-recommendations`: survey the repository, find significant improvements, and write the
recommendations to the scan file Auto Scout named. This turn produces a recommendation document,
nothing else.

## Contract

- The scan directory is the command argument, absolute and outside your control:
  `<scan-dir>`. Read `<scan-dir>/request.json` once; it carries `requested`, `categories`,
  `excludedRoots`, `knownTitles`, `draftGoalHeadings`, `significanceThreshold`, and
  `repositoryPath`.
- `<repositoryPath>` is the repository to survey. Never survey or write outside it, and never
  read inside an `excludedRoots` tree: generated output, vendored packages, temporary state, and
  worktrees are not the repository under review. Every `path` you cite is relative to that exact
  root: a file under a subdirectory keeps that leading directory in the path, never a shorter
  form. Before writing the answer, confirm every cited path with `test -f <path>` from
  `<repositoryPath>`.
- One correction turn is available: if validation rejects the answer, rewrite
  `<scan-dir>/recommendations.json` addressing exactly what the rejection names.
- Read the repository's context files (`AGENTS.md`, `GOAL.md`, `README.md`, `adrs/`, `docs/`), its
  package manifests, its source, and its tests before proposing anything. A finding you cannot
  point at in the code is not a finding.
- Deliverable: exactly one file, `<scan-dir>/recommendations.json`. Write nothing else, anywhere.
- Never modify the repository: no edits, no formatting, no new files inside it, no branches,
  commits, stashes, builds, tests, installs, or any command that mutates the checkout or its git
  state. Read-only inspection only.
- Never file an issue, write a draft goal, or touch `.devboard/goal-proposals/`.
- Never ask the developer a question, request permission, or wait for input. Decide with what the
  repository shows, finish in this one turn, and write the file.
- The delivered count is at most `requested`. Fewer significant findings than requested is a
  correct answer, with a non-empty `shortfall` reason. Never pad the list, never invent filler,
  and never repeat a finding to reach the count.
- `knownTitles` is the normalized form of every existing Auto Scout issue title and every open
  issue title; `draftGoalHeadings` is every draft goal heading. Never restate, paraphrase, or
  split one of those findings: the worker drops such an item and records it.

## Significance

Every item carries an integer `significance` from 1 to 5 and a non-empty `significanceReason`.
Score honestly; the worker files only items scored 4 or 5, so an inflated score wastes a filing
slot and an honest 3 is a correct answer.

- **4 or 5 requires a named, observable impact.** Name one of: a reproducible defect, a real
  failure mode (an input, state, or ordering that makes the code do the wrong thing), or a
  measured structural cost (a duplicated rule whose copies already disagree, a measured build or
  runtime cost, a boundary with no test that would let a real regression pass).
  - 5: the impact is reachable now and correctness- or data-affecting.
  - 4: the impact is real and named, but narrower or latent.
- **3:** a real observation with no observable impact named yet — a latent inconsistency, an
  unexercised cleanup, a structural preference. Do not file it.
- **2 or 1:** polishing code that is already correct, style, formatting, comment wording, a
  speculative rewrite, or a generic "add tests" item with no named gap. Never a deliverable.

`significanceReason` states the impact in one or two sentences. "It would be cleaner" is not an
impact. "`parseA` and `parseB` disagree on a trailing slash, so a path with one is rejected by
the first and accepted by the second" is.

## What to survey

Read widely enough to judge significance, then look for:

- duplication: the same logic, rule, or literal in several places that should be one;
- unclear or inconsistent naming: one concept under two names, or a name that promises something
  the code does not do;
- entities that should merge or split: a module doing two jobs, or two modules that only work
  together;
- long or tangled units: a function or component whose branches hide its intent;
- missing or weak tests: a named behavior, boundary, or failure path with no test, or a test that
  cannot fail;
- unhandled inputs and failures: an unchecked external value, a filesystem or network call with no
  failure path, a promise nobody awaits;
- swallowed errors: a `catch` that discards the reason, a fallback that hides a real failure;
- race or ordering hazards: shared state written from two paths, work that assumes an order the
  code does not enforce.

Prefer one high-impact finding over three easy ones. A finding earns its place only if fixing it
changes behavior, correctness, or the cost of the next change.

## What never ships

Do not propose: style or formatting preferences; comment-only changes; speculative rewrites with
no defect named; a dependency, framework, or architecture swap as an end in itself; a generic
"add tests" item with no named gap; or anything already filed, open as an issue, or present as a
draft goal. Those titles are in the request; never restate them, and never propose a paraphrase
of one.

Every item must cite at least one concrete `path:lines` inside the repository and at least one
acceptance criterion an implementer can verify by running something.

## Output

Write `<scan-dir>/recommendations.json` as one JSON object:

```json
{
  "recommendations": [
    {
      "category": "clarity",
      "title": "One line, at most 200 characters, no trailing period",
      "summary": "What is wrong and why it matters, in two or three sentences.",
      "impact": "What improving it changes for the next developer or for correctness.",
      "significance": 4,
      "significanceReason": "The named defect or measured cost, in one or two sentences.",
      "evidence": [
        {
          "path": "path/inside/the/repository.ts",
          "lines": "120-148",
          "quote": "A short verbatim excerpt from those lines."
        }
      ],
      "proposedChange": "The change to make, concretely and without prescribing unrelated work.",
      "files": ["path/inside/the/repository.ts"],
      "acceptanceCriteria": [
        "A statement that can be checked by reading the code or running the test suite."
      ]
    }
  ],
  "shortfall": "Why fewer than the requested count were delivered, or omit it when the count is met."
}
```

Field rules:

- `category` is exactly one of `clarity`, `structure`, `naming`, `tests`, `robustness`,
  `correctness`.
- `title` is one line, at most 200 characters, specific enough to be an issue title.
- `summary`, `proposedChange`, and every `acceptanceCriteria` entry are non-empty.
- `significance` is an integer from 1 through 5; `significanceReason` is non-empty and names the
  impact at 4 or 5.
- `evidence` has at least one entry. `path` is repository-relative with `/` separators, names an
  existing regular file outside the excluded roots, and `lines` is `N` or `N-M` inside that
  file's real line count. `quote` is optional and verbatim.
- `files` is non-empty and every entry also appears in `evidence[].path`.
- `recommendations` holds at most `requested` items.
- `shortfall`, when present, is a non-empty sentence naming why the repository does not offer
  more significant findings.

A missing or out-of-range score, or a missing reason, rejects the whole answer and files nothing.
Do not print the JSON as your answer; write it to the file and end the turn. If the repository
affords no significant finding, write `{"recommendations": [], "shortfall": "…"}`.
