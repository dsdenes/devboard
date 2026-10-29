---
description: Audit the harness interface against DESIGN.md and design/tokens.json, file design-system divergences, and improve the documented standard.
---

`/design-system-audit`: audit the interface source against its design documents, then write the
cycle's answer and, only when a standard is admissible, revise the two documents in your draft.

## Contract

- The cycle directory is the command argument, absolute and outside your control: `<cycle-dir>`.
  Read `<cycle-dir>/request.json` and `<cycle-dir>/input.json` once.
- `<cycle-dir>/input.json` carries `sources` (every audited interface file with its path, line
  count, and text) and `documents` (the current `DESIGN.md` and `design/tokens.json`).
- `<cycle-dir>/draft/` is yours: it holds a copy of both documents at their repository-relative
  paths. You may edit only those two draft files, and only for an admissible documentation
  decision. Never touch the repository itself.
- Deliverable: exactly `<cycle-dir>/audit.json`, plus draft document edits when admissible.
  Write nothing else.
- Never modify the checkout, never run git, never file an issue, never build, test, or install.
  This turn is read-only outside the cycle directory.
- Never ask a question, request permission, or wait for input. Finish in one turn.
- Every finding must be a divergence from the documents in one of `request.json`'s `categories`:
  `color`, `typography`, `spacing`, `wording`, `state`, `placement`. Backend, security,
  performance, dependency, and unrelated findings are out of scope: leave them out.
- No title prefix. A finding title is a plain, non-empty sentence fragment of at most 200
  characters. Never restate a title in `knownTitles`.
- Evidence is exact: each entry carries a repository-relative `path` from `input.sources`, a
  `lines` span inside that file, and a `quote` copied verbatim from those lines.
- The documents are normative. A client value, state treatment, wording, spacing, or placement
  the documents do not cover is a divergence and becomes a finding. Never treat undocumented
  behavior as the standard.

## audit.json

```json
{
  "findings": [
    {
      "category": "color",
      "title": "One sentence naming the divergence",
      "principle": { "name": "Named principle or rule", "passage": "Quoted passage from the documents" },
      "token": { "name": "accent", "value": "#58a6ff" },
      "evidence": [
        { "path": ".devboard/client/Foo.svelte", "lines": "12-14", "quote": "exact source text" }
      ],
      "files": [".devboard/client/Foo.svelte"],
      "proposedChange": "The exact change that removes the divergence.",
      "acceptanceCriteria": ["Binary, observable result one.", "Binary, observable result two."]
    }
  ],
  "documentation": { "decision": "none" }
}
```

`token` is optional. `files` names every affected interface file. `acceptanceCriteria` are
binary statements that can be checked, never "looks better".

## Documentation decisions

A documentation edit is admissible only when it establishes or corrects a standard evidenced by
at least two distinct interface surfaces, or by an internal contradiction inside the documents.
Never edit a document merely to record a single existing literal, and never bless a divergence
already reported as a finding.

When admissible, edit `<cycle-dir>/draft/DESIGN.md` and
`<cycle-dir>/draft/design/tokens.json` surgically, and answer:

```json
{
  "findings": [],
  "documentation": {
    "decision": "edit",
    "summary": "One sentence for the commit subject.",
    "rationale": "Why this standard is now documented and which drift it prevents.",
    "surfaces": [".devboard/client/A.svelte", ".devboard/client/B.svelte"],
    "contradiction": false,
    "evidence": [],
    "addsTokens": ["optional-token-name"]
  }
}
```

`DESIGN.md` must contain both `## Design principles` and `## UX principles` in every revised
draft. When the current document lacks either section, add it with principles drawn from the
documented tokens and the audited surfaces; adding a missing section is a required part of the
edit, not unrelated prose. A token addition or correction appears in both the prose tables and
`design/tokens.json`. Change no other prose. When no admissible decision exists, answer
`{"decision": "none"}` and leave the drafts untouched.
