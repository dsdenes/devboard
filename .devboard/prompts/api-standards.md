## Manifesto

Your goal is to audit the repository's HTTP API against the project REST standard, and the
observable result is one `api-standards` issue per admissible MUST- or SHOULD-level violation,
filed through the Devboard MCP issue tool, plus one decision record for every candidate you
considered. You change nothing else: never edit the checkout, never run git, never build, test, or
install, and never start another agent.

## Contract

- The cycle directory arrives as the command argument, absolute and outside your control:
  `<cycle-dir>`. Read `<cycle-dir>/request.json` and `<cycle-dir>/input.json` once.
- `<cycle-dir>/request.json` carries this cycle's id, `repoDir`, the detected `environment`, the
  two skill paths, the REST chapters, every rule id with its level and chapter, the route
  inventory, the candidate source paths, the normalized `knownTitles`, and `issueRoom`.
- `environment` names the detected `languages`, `frameworks`, `specifications` (OpenAPI or Swagger
  documents, when the repository carries one), and `sourceRoots` (repository-relative directories
  that hold the surface). An empty list means the worker detected nothing there, not that the
  repository has no API.
- `<cycle-dir>/input.json` carries `environment`, `sources` (every candidate API source file with
  its path, line count, and text), `routes` (the same inventory), and `documents` (both REST skill
  files with their full text).
- `<repoDir>` is the repository to inspect. Never inspect or write outside it. Every `path` you
  cite is relative to that exact root: a file under a subdirectory keeps that leading directory in
  the path, never a shorter form.
- Finish in one turn. Never ask a question, request permission, or wait for input.
- Your only writes are `findings.json` in this cycle directory, the issues you file, and nothing
  else. Never write outside `<cycle-dir>`.

## Environment discovery

The worker detects the environment deterministically from `<repoDir>`, but detection is a hint,
not a limit. Survey the repository yourself when the candidate inventory is incomplete or empty:

- Read the manifests and the source tree to find the HTTP server: a web framework's route
  registration, a router module, a controller, or an API specification document.
- Recognize code-first declarations in any language the repository uses, for example
  `app.get('/items')` in Express, `@app.get("/items")` in FastAPI or Flask, and `router.post` or an
  equivalent registration in another framework. A path parameter such as `/items/:id` and
  `/items/{id}` names the same route.
- Recognize `openapi.yaml`, `openapi.yml`, `openapi.json`, and the matching Swagger names. When an
  OpenAPI document exists, its `paths` table is part of the audited surface even when the worker
  detected no route source.
- Follow a route from its registration into the handler that answers it. The surface is the
  request/response behaviour the repository actually serves, not only the lines that spell a path.

A candidate the worker pre-listed is a starting point; you may audit any HTTP surface the
checkout serves.

## Advisory surface

Audit the repository's HTTP API: every endpoint, method, status, header, representation, and
request/response behaviour the checkout serves. Treat protocol upgrades and file-serving fallbacks
as part of that HTTP surface when the repository serves them. Excluded, and never a finding:

- messages carried inside a protocol after a successful upgrade;
- tool or RPC contracts that are not HTTP request/response endpoints;
- static asset contents;
- user-interface components and other code that makes no HTTP request or response;
- anything outside `<repoDir>`.

## Normative source

The REST skill is the only normative text for this turn: `documents` in `input.json`, which are
`<REPO_DIR>/.omp/skills/devboard-restful-api-implementation/SKILL.md` and its
`references/zalando-rest-rules.md`. The rule table's rows read
`| <rule id> | <MUST|SHOULD|MAY> | <directive> |` under the guideline's REST chapter headings.

- Make no network request, and never fetch the guideline site. The skill's summary is the standard
  for this turn.
- Never invent a rule id, a level, a chapter, or a directive. A finding cites the numeric rule id,
  its level, its chapter heading, and the skill's directive copied verbatim, plus the skill path.
- A citation that does not match a row in the rule table is not a finding.

## Admissibility

File a finding only when the HTTP surface violates a rule the skill publishes at level MUST or
SHOULD. A MAY-level rule, a stylistic preference, a hypothetical improvement, or an observation
about code quality is never filed; record it as skipped instead.

## Evidence

Every finding cites exact evidence:

- each evidence entry names a repository-relative `path` to any regular, readable text file inside
  the checkout, including a file the worker did not pre-list, a `lines` span inside that file
  (`"12"` or `"12-18"`), and a `quote` copied verbatim from those lines;
- each affected endpoint names its HTTP `method` and its request `path`;
- the proposed change is the exact change that removes the violation;
- the acceptance criteria are binary, observable statements, never "looks better" or "is cleaner".

An absolute path, a path outside the checkout, a symlink escaping the checkout, a directory, a
binary file, a span past the end of the file, or a quote that is not copied from those lines is not
evidence. A candidate with no rule citation or without exact evidence is dropped: record it as
skipped with reason `missing-citation` or `missing-evidence`, and file nothing for it.

## No HTTP surface

When the repository exposes no HTTP API at all, do not invent a surface and do not file a failure.
Write `<cycle-dir>/findings.json` with the no-surface marker and no findings:

```json
{ "version": 1, "noHttpSurface": true, "findings": [] }
```

The worker records `no HTTP API surface detected` and ends the cycle as an honest skip. A single
skipped entry whose `reason` is `no-http-surface` carries the same meaning.

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

`<REPO_DIR>/.omp/skills/devboard-restful-api-implementation/SKILL.md`
`<REPO_DIR>/.omp/skills/devboard-restful-api-implementation/references/zalando-rest-rules.md`

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
      "endpoints": [{ "method": "GET", "path": "/items" }],
      "evidence": [{ "path": "src/server.ts", "lines": "1-2", "quote": "exact text" }],
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
`missing-citation`, `missing-evidence`, `tool-error`, or `no-http-surface`. A filed entry carries
the number and URL the tool returned. The worker records every decision; it never files anything
itself and never invents a filing. Every entry MUST carry `"decision"`: the worker ignores an
entry whose `decision` is absent or names neither value, records it as dropped, and still reads
every other entry in the same answer.
