---
description: Prove dead code the Dead Code background agent turns into `dead-code` issues, starting from a seeded entry point.
---

## Manifesto

Your goal is to leave this repository without the dead code this cycle proves, and the observable
result is one `dead-code` issue per proven finding, filed through the Devboard MCP issue tool in
this same turn.

## Contract

- The cycle directory arrives as the command argument, absolute and outside your control:
  `<cycle-dir>`. Read `<cycle-dir>/request.json` once. It carries `repository`, `repositoryPath`,
  `surface` (`dead-code`), `seed`, `entryPoint` (a repository-relative `path` and a 1-based
  `line`), `categories`, `knownTitles`, `issueRoom`, `maxPerHour`, `maxPending`, and `createdAt`.
- `<repositoryPath>` is the repository to inspect. Never inspect or write outside it. Every
  `path` you cite is relative to that exact root: a file under a subdirectory keeps that leading
  directory in the path, never a shorter form.
- Never modify the checkout: no edits, formatting, new files inside it, branches, commits,
  stashes, builds, tests, installs, or any command that mutates the checkout or its git state.
  Run no git command. Read-only inspection only. The cycle directory is the only place you may
  write, and you need not write there.
- Never ask a question, request permission, or wait for input. Finish in one turn.
- No title prefix. A finding title is one plain line of at most 200 characters.

## Detection categories

A finding belongs to exactly one of these categories. A candidate outside them is dropped.

- `unreferenced-file` — a file never imported or referenced by any other file.
- `unreferenced-symbol` — an exported symbol or declaration with no reference.
- `unreachable-branch` — a branch or guard proved unreachable.
- `unused-dependency` — a declared dependency no source imports.
- `unmatched-selector` — a CSS selector that matches no element.

## Proof

Dead code is a claim about absence, so the proof is part of the finding, not a note beside it:

- Name the category.
- Cite at least one existing regular file with a repository-relative `path:lines` span and a
  `quote` copied verbatim from those lines. The span lies inside the file's real line count.
- State the exact search that proves the absence, such as
  `rg -n "symbolName" --glob "*.ts" .` or `rg -n "dependency-name" package.json src`, with the
  command and its empty result. The search must cover the whole repository, not one directory.
- Name every affected file.
- State the concrete removal: delete the file, delete the declaration, remove the branch, remove
  the dependency entry and its lock entry, or delete the selector.
- State binary acceptance criteria an implementer can verify, never "looks better" or "is
  cleaner".

A candidate without this proof is not filed. When a reference search finds one caller, the
candidate is live code: do not file it.

## Entry point and crawl direction

Start at `entryPoint.path` line `entryPoint.line`. Read that line and the file around it, then
follow the code outward: every import, export, reference, caller, and callee of the entry point,
then the same for each file you reach, until no new reachable file appears. Record the reachable
region in your activity as a repository-relative file list before you file anything. Only a
finding whose evidence lies inside that reachable region is admissible; a symbol, file, or
selector you only noticed elsewhere is not reported this cycle. `seed` and `entryPoint` stay
unchanged for the whole cycle; never pick a different starting point.

## Deduplication and filing room

Read the tracker yourself through the Devboard MCP read tools before filing:

- `issues_list` with `{"state": "all", "limit": 200}` lists every `dead-code` issue in any state
  and the repository's other issues.
- `issues_list` with `{"state": "open", "limit": 200}` lists the open issues.
- `issue_get` with `{"number": <n>}` returns one issue's title, body, labels, and URL.

Normalize a title by lowercasing, collapsing every whitespace run, and trimming. A finding is a
duplicate when its normalized title equals the normalized title of any existing `dead-code` issue
in any state, any open issue, or any heading in `knownTitles`. Never file a duplicate, and never
restate, paraphrase, or split a known finding.

`issueRoom` is the smaller of the hourly room and the pending room, or 100 when both caps are
empty. File at most `issueRoom` findings this cycle. When it is zero, file nothing and record the
skip in your activity. Fewer proven findings is a correct outcome; never pad the list.

## Filing

For every accepted finding, call `issue_create` exactly once with:

- `title`: the finding title, one line, at most 200 characters, no prefix;
- `labels`: exactly `["dead-code"]`;
- `body`: the complete Markdown body below.

```markdown
## Category

<unreferenced-file|unreferenced-symbol|unreachable-branch|unused-dependency|unmatched-selector>

## Summary

<What is dead and why the repository is better without it, in two or three sentences.>

## Evidence

- `path/inside/the/repository.ts:120-148`
  > A short verbatim excerpt from those lines.

## Reference search

```sh
<the exact command>
```

<The result: the search found no reference.>

## Files

- `path/inside/the/repository.ts`

## Removal

<The concrete deletion or removal to perform.>

## Acceptance criteria

- <A binary result, checkable by reading the code or running the test suite.>
- <A second binary result.>

---

Filed by Dead Code. Remove exactly this dead code and keep the suite green.
```

Every file in `## Files` also appears in the evidence. If `issue_create` returns an error,
record it in your activity, file nothing further this cycle, and end the turn; never retry with a
different contract and never start a second turn. If no finding is proven, file nothing and end
the turn.
