---
description: Audit the dashboard's HTTP API against the project REST skill and file spelled-out conformance issues through the issue tool.
---

## Manifesto

Your goal is to report where the dashboard's own HTTP API violates the project REST standard, and
the observable result is one `api-standards` issue per admissible MUST- or SHOULD-level violation,
filed through the Devboard MCP issue tool, plus one decision record for every candidate you
considered. You change nothing else: never edit the checkout, never run git, never build, test, or
install, and never start another agent.

## Contract

- The cycle directory arrives as the command argument, absolute and outside your control:
  `<cycle-dir>`. Read `<cycle-dir>/request.json` and `<cycle-dir>/input.json` once.
- `<cycle-dir>/request.json` carries this cycle's id, the audited source directory, the two skill
  paths, the REST chapters, every rule id with its level and chapter, the route inventory, the
  audited source paths, the normalized `knownTitles`, and `issueRoom`.
- `<cycle-dir>/input.json` carries `sources` (every audited API source file with its path, line
  count, and text), `routes` (the same inventory), and `documents` (both REST skill files with
  their full text).
- Finish in one turn. Never ask a question, request permission, or wait for input.
- Your only writes are `findings.json` in this cycle directory, the issues you file, and nothing
  else. Never write outside `<cycle-dir>`.

## Normative source

The REST skill is the only normative text for this turn: `documents` in `input.json`, which are
`<REPO_DIR>/.omp/skills/restful-api-implementation/SKILL.md` and its
`references/zalando-rest-rules.md`. The rule table's rows read
`| <rule id> | <MUST|SHOULD|MAY> | <directive> |` under the guideline's 15 REST chapter headings.

- Make no network request, and never fetch the guideline site. The skill's summary is the standard
  for this turn.
- Never invent a rule id, a level, a chapter, or a directive. A finding cites the numeric rule id,
  its level, its chapter heading, and the skill's directive copied verbatim, plus the skill path.
- A citation that does not match a row in the rule table is not a finding.

## Audited surface

Audit the HTTP surface the dashboard server exposes, as `request.json`'s `routes` describes it:
the endpoints, the `/ws` upgrade with its refusal and method handling, and the static-file
fallback. Every file in `sources` is the server's own routing, request parsing, and response code;
a route that appears in those files but not in `routes` is still part of the surface.

Excluded, and never a finding:

- the WebSocket messages carried after a successful upgrade;
- the MCP tool contract;
- the static asset contents;
- anything outside the dashboard's HTTP request/response surface.

## Admissibility

File a finding only when the HTTP surface violates a rule the skill publishes at level MUST or
SHOULD. A MAY-level rule, a stylistic preference, a hypothetical improvement, or an observation
about code quality is never filed; record it as skipped instead.

## Evidence

Every finding cites exact evidence:

- each evidence entry names a repository-relative `path` from `sources`, a `lines` span inside that
  file (`"12"` or `"12-18"`), and a `quote` copied verbatim from those lines;
- each affected endpoint names its HTTP `method` and its request `path`;
- the proposed change is the exact change that removes the violation;
- the acceptance criteria are binary, observable statements, never "looks better" or "is cleaner".

A candidate with no rule citation or without exact evidence is dropped: record it as skipped with
reason `missing-citation` or `missing-evidence`, and file nothing for it.

## Deduplication

Normalize a title by lowercasing, collapsing every whitespace run, and trimming. A candidate is a
duplicate when its normalized title equals the normalized title of any existing `api-standards`
issue in any state (read them with `issues_list` `{"state": "all", "limit": 200}`) or of any open
issue in the repository (`{"state": "open", "limit": 200}`), or of any entry in `knownTitles`.
Never file a duplicate: record it as skipped with reason `duplicate`. Never restate, paraphrase, or
split a known finding to reach a count.

## Filing room

`request.json`'s `issueRoom` already reflects the configured rolling-hour cap, the open-issue cap,
and the 100-per-cycle limit. File at most `issueRoom` issues. When `issueRoom` is 0, file nothing
and record every candidate as skipped with reason `no-room`. Caps never excuse skipping the audit.

## Filing

For each admissible, non-duplicate finding within the room, call `issue_create` exactly once with:

- `title`: the finding title, no prefix, non-empty, at most 200 characters;
- `labels`: exactly `["api-standards"]`;
- `body`: the complete Markdown body below.

```markdown
## Chapter

<the skill's chapter heading>

## Rule

**<numeric rule id> — <MUST|SHOULD>**

## Directive

> <the skill's directive, verbatim>

## Skill

`<REPO_DIR>/.omp/skills/restful-api-implementation/SKILL.md`
`<REPO_DIR>/.omp/skills/restful-api-implementation/references/zalando-rest-rules.md`

## Evidence

- `path:lines`
  > exact source text

## Endpoints

- `METHOD /path`

## Proposed change

<The exact change that removes the violation.>

## Acceptance criteria

- <Binary, observable result one.>
- <Binary, observable result two.>
```

If `issue_create` returns an error, record that candidate as skipped with reason `tool-error` and
the error's first line; continue with the remaining candidates; never retry with a different
contract and never claim a filing that did not happen.

## Decision record

After the turn's filings, write `<cycle-dir>/findings.json` as one JSON object:

```json
{
  "version": 1,
  "findings": [
    {
      "title": "<the candidate's title>",
      "ruleId": "<numeric id>",
      "level": "<MUST|SHOULD|MAY>",
      "chapter": "<the skill's chapter heading>",
      "directive": "<the skill's directive, verbatim>",
      "endpoints": [{ "method": "GET", "path": "/api/example" }],
      "evidence": [{ "path": "path/from/sources", "lines": "1-2", "quote": "exact text" }],
      "proposedChange": "<the change>",
      "acceptanceCriteria": ["<binary result>"],
      "decision": "filed",
      "issueNumber": 123,
      "issueUrl": "https://forge/owner/repo/issues/123"
    }
  ]
}
```

Write one entry for every candidate you considered, filed or skipped. A skipped entry carries
`"decision": "skipped"` and a `reason` of `may-level`, `duplicate`, `no-room`, `outside-http`,
`missing-citation`, `missing-evidence`, or `tool-error`. A filed entry carries the number and URL
the tool returned. The worker records every decision; it never files anything itself and never
invents a filing.
