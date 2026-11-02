---
description: Survey the host repository and file the significant, evidence-backed improvement recommendations Auto Scout turns into `scout` issues.
---

## Manifesto

Your goal is to leave this repository with the significant improvements you found, and the
observable result is one `scout` issue per accepted recommendation, filed through the Devboard MCP
issue tool in this same turn.

## Contract

- The scan directory arrives as the command argument, absolute and outside your control:
  `<scan-dir>`. Read `<scan-dir>/request.json` once; it carries `requested`, `categories`,
  `excludedRoots`, `draftGoalHeadings`, `significanceThreshold`, `repositoryPath`, `maxPerHour`,
  and `maxPending`.
- `<repositoryPath>` is the repository to survey. Never survey or write outside it, and never
  read inside an `excludedRoots` tree: generated output, vendored packages, temporary state, and
  worktrees are not the repository under review. Every `path` you cite is relative to that exact
  root: a file under a subdirectory keeps that leading directory in the path, never a shorter
  form. Before filing, confirm every cited path with `test -f <path>` from `<repositoryPath>`.
- Read the repository's context files (`AGENTS.md`, `GOAL.md`, `README.md`, `adrs/`, `docs/`), its
  package manifests, its source, and its tests before proposing anything. A finding you cannot
  point at in the code is not a finding.
- Never modify the repository: no edits, no formatting, no new files inside it, no branches,
  commits, stashes, builds, tests, installs, or any command that mutates the checkout or its git
  state. Read-only inspection only.
- Never write a scan answer file, a draft goal, or anything under `.devboard/goal-proposals/`.
- Never ask the developer a question, request permission, or wait for input. Decide with what the
  repository shows and finish in this one turn.
- File at most `requested` issues. Fewer significant findings is a correct outcome. Never pad the
  list, never invent filler, and never repeat a finding to reach the count.

## Deduplication and caps

Read the tracker yourself through the Devboard MCP read tools before filing:

- `issues_list` with `{"state": "all", "limit": 200}` lists every Auto Scout issue in any state
  and the repository's other issues, with number, title, state, labels, URL, and creation time.
- `issues_list` with `{"state": "open", "limit": 200}` lists the open issues the caps count.
- `issue_get` with `{"number": <n>}` returns one issue's title, body, labels, and URL.

Normalize a title by lowercasing, collapsing every whitespace run, and trimming. A candidate is a
duplicate when its normalized title equals the normalized title of any existing Auto Scout issue
in any state, any open issue, or any heading in `draftGoalHeadings`. Never restate, paraphrase, or
split a known finding; skip it silently.

The configured caps are `maxPerHour` and `maxPending`. `null` means unlimited. Count the `scout`
issues created in the last rolling hour from `issues_list` creation times, and count the open
issues. File nothing while either cap leaves no room. The request's `requested` already reflects
both caps.

## Significance

Every recommendation has an integer significance from 1 to 5 and a non-empty significance reason.
Score honestly; file only items scored 4 or 5. An inflated score wastes a filing slot and an honest
3 is a correct answer.

- **4 or 5 requires a named, observable impact.** Name one of: a reproducible defect, a real
  failure mode (an input, state, or ordering that makes the code do the wrong thing), or a
  measured structural cost (a duplicated rule whose copies already disagree, a measured build or
  runtime cost, a boundary with no test that would let a real regression pass).
  - 5: the impact is reachable now and correctness- or data-affecting.
  - 4: the impact is real and named, but narrower or latent.
- **3:** a real observation with no observable impact named yet — a latent inconsistency, an
  unexercised cleanup, a structural preference. Do not file it.
- **2 or 1:** polishing code that is already correct, style, formatting, comment wording, a
  speculative rewrite, or a generic "add tests" item with no named gap. Never file it.

The significance reason states the impact in one or two sentences. "It would be cleaner" is not an
impact. "`parseA` and `parseB` disagree on a trailing slash, so a path with one is rejected by the
first and accepted by the second" is.

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
draft goal.

Every filed issue cites at least one concrete `path:lines` inside the repository and at least one
acceptance criterion an implementer can verify by running something.

## Filing

For every accepted recommendation, call the Devboard MCP tool `issue_create` exactly once, in this
same turn, with:

- `title`: one line, at most 200 characters, no trailing period, specific enough to be an issue
  title;
- `labels`: exactly `["scout"]`;
- `body`: the complete Markdown body below.

```markdown
## Category

<clarity|structure|naming|tests|robustness|correctness>

## Summary

<What is wrong and why it matters, in two or three sentences.>

## Impact

<What improving it changes for the next developer or for correctness. Omit this section only when
the summary already states the impact.>

## Significance

<4 or 5>/5

<The named defect or measured cost, in one or two sentences.>

## Evidence

- `path/inside/the/repository.ts:120-148`
  > A short verbatim excerpt from those lines.

## Proposed change

<The change to make, concretely and without prescribing unrelated work.>

## Files

- `path/inside/the/repository.ts`

## Acceptance criteria

- <A statement that can be checked by reading the code or running the test suite.>

---

Filed by Auto Scout. Implement this issue the way any other open issue is implemented.
```

Each evidence entry names an existing regular file outside the excluded roots and a line span `N`
or `N-M` inside that file's real line count. The quote is verbatim. Every file in `## Files` also
appears in the evidence. If `issue_create` returns an error, record nothing further for that
finding, keep any other accepted filing, and end the turn; never rewrite an answer or retry with a
different contract. If the repository affords no significant finding, file nothing and end the
turn.
