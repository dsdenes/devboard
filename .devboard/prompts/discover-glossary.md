---
description: Crawl the host read-only and stage the UbiLang glossaries, their significance scores, and the glossary Discover skill.
---

## Manifesto

Your goal is to name the host's own domain language, and the observable result is the run's
staged glossaries, significance scores, and glossary skill written through the Devboard MCP
staging tools and then published by the server.

## Contract

- `<host>` is the git top level: `git rev-parse --show-toplevel`. If that fails, use the current
  working directory.
- `<staging-dir>` is the run's staging directory, passed to every staging tool call. The tools are
  the only writers; never create or edit a staged file by hand.
- The server owns publication. Never write outside the run's staging directory, and never touch
  `<host>/.omp/discover/`, `<host>/.omp/skills/`, `<host>/GOAL.md`, anything under `<host>/adrs/`,
  or any host source file.
- Never write `manifest.json` or `decisions.json`; the server generates both.
- This is a read-only crawl. Read files and use only these safe read-only git facts:
  `git rev-parse`, `git log`, `git branch`, `git status`, `git ls-files`. Run no other git
  subcommand and no project command, test, build, package-manager step, install, formatter, code
  generator, web fetch, forge query, or network request. The only network traffic in this turn is
  the model endpoint that serves this session.
- Record configuration names and environment variable names, never their values. Never copy a
  token, credential, password, private key, secret, private URL, or URL containing user info into
  any staged file.
- If `<staging-dir>` is missing, empty, unwritable, or outside `<host>/.omp/discover/staging/`,
  reply exactly `halt: staging directory is not usable` and stop. Otherwise write no status line.

## Crawl

Read only what you need, so the glossary maps this host's own language.

1. Inventory the git top level with `git ls-files` and `git status`.
2. Read source, tests, routes, schemas, and documentation for the project's named concepts, and
   group them by bounded context.
3. Read `README`, `AGENTS.md`, `GOAL.md`, and `adrs/` when present as evidence and context only:
   never edit them and never copy their prose into a value.
4. Exclude from the crawl entirely: `<host>/.devboard/`, `<host>/.worktree/`, `<host>/.git/`
   internals, every path under `<host>/.omp/`, package manager and tool caches, virtual
   environments, build and coverage outputs, and every ignored path. Do not cite an excluded path
   as evidence.
5. Do not open files that plainly hold secrets, such as environment value files, keystores, or
   credential stores.
6. Read the currently published `<host>/.omp/discover/glossary/` and
   `<host>/.omp/discover/decisions.json` when present, read-only. They record human decisions that
   must be preserved, and nothing in this turn depends on them.

Never block on an ambiguity and never ask a question. When the evidence is absent or insufficient,
omit the concept or propose it explicitly. Never invent a term, a definition, a grounding path, or
a bounded context.

## Staging

Call `discover_glossary_stage` once per detected bounded context with `stagingDir` set to
`<staging-dir>`, `context` set to the kebab-case bounded-context id, and `yaml` set to that
document's complete text. At least one bounded context must be detected. Then call
`discover_significance_stage` once with the complete significance object, and
`discover_skill_stage` once with `name` `discover-glossary`, its one-line description, and its
heading-plus-bullets body. The tools write the run's staged artifacts; write no other file, note,
log, or temporary file. Order every object key, array, and enum exactly as specified.

## Glossary (UbiLang)

Pass one YAML document per detected bounded context. It must be a complete, parseable UbiLang
glossary.

Top-level key order: `boundedContext`, `titles`, `concepts`. `titles` is a list of
`{language, text}` entries.

Each concept carries these keys in this order:

```
id, prefLabels, altLabels, hiddenLabels, definitions, scopeNote, example, historyNote,
status, origin, standardRef, kind, grounding, broader, related
```

- `id` is kebab case, unique in the document; `boundedContext` is also kebab case.
- `prefLabels`, `altLabels`, and `definitions` are lists of `{language, text}` with `language`
  `en` or `de`. `prefLabels` is non-empty, has at most one entry per language, and always includes
  an `en` label. Every concept has at least one `en` definition. `altLabels` may be `[]`.
- `hiddenLabels` is `[]`; a hidden or rejected label is a human decision the server preserves, so
  this crawl never synthesizes one.
- `scopeNote`, `example`, `historyNote`, `standardRef`, and `broader` may be `null` when unused.
  `related` is a list, `[]` when none. `broader` and `related` name concept ids that exist in the
  same document.
- `status` is one of `confirmed`, `unconfirmed`, `proposed`, `deprecated`, `invalidated`. This
  crawl writes only `unconfirmed` for a term found in existing code or documentation and
  `proposed` for a term the agent names for an existing but unnamed concept. Never write
  `confirmed`, `deprecated`, or `invalidated`; those are human decisions the server preserves.
- `origin` is one of `owner`, `standard`, `llm`. Grounded existing terms use `owner` or `standard`;
  an agent proposal uses `llm`. `origin: standard` requires a `standardRef`.
- `kind` is one of `entity`, `event`, `field`, `role`, `actor`, `value`, `rule`.
- `grounding` is a non-empty list. Each entry is `code:<repository-relative path of one host
  file>` or `model:<symbol or model name that appears in the crawled host>`. A `code:` entry names
  a tracked or untracked file the crawl may cite, never a directory, an ignored path, or a path
  under an excluded tree. The `model:` name matches
  `^[A-Za-z_][A-Za-z0-9_.-]*$` and appears as a whole word in one crawled file. A candidate with
  no grounding is omitted, never invented.
- Fields use camelCase; enum values use the exact snake_case spelling above. Write no undeclared
  field. Keep every label, definition, and note on one line of at most 160 characters; a definition
  is one sentence.
- Detect at least one bounded context, and give every glossary document at least one grounded
  concept. When the source contains a named concept, define it; when it contains an important
  unnamed concept, propose one explicitly with `status: proposed` and `origin: llm`.
- Prefer significant, project-specific concepts over generic vocabulary. The preferred label is
  the domain's own compound name, such as a multi-word term or a compound identifier that appears
  in the host's code and documentation. Omit generic framework words and single generic tokens
  (`option`, `command`, `value`, `config`, `error`, `page`, `action`, `data`, `file`, `name`,
  `state`, `request`, `response`, `type`) unless the host defines that exact term as a
  project-specific concept with a one-sentence definition and grounds it in at least two files.
  The glossary maps the host's language; it is not an inventory of its framework.
- Prefer concepts whose grounding spans more than one file, and record every code path and model
  symbol that demonstrates the concept. A concept the operator would not recognize as part of this
  project's domain does not belong in the glossary.

Never give an invalidated or human-rejected term a new proposed or unconfirmed entry, never
resurrect an invalidated id, and never restate a human rejection. The server merges human decisions
during publication; do not copy `confirmed` or `invalidated` statuses into the staged files.

## Glossary significance

A concept belongs in the glossary only when the host itself names it as part of the project's
domain. Omit generic framework, library, language, and UI vocabulary: never include `option`,
`hook`, `command`, or any comparable generic token unless the host defines that exact term as a
project concept and grounds it in at least two distinct host files. A label that would read the same
in an unrelated project is evidence of generic vocabulary, not of a project concept.

Score every included concept on a scale from 0 to 100. 50 is the significance floor: a score at or
above it means the concept is central enough to name in the project's own language, and a score
below it means the term is incidental. Score from the crawling evidence, not from how often a word
occurs: a term mentioned a thousand times is insignificant when the host merely passes it through,
and a domain term named once is significant when the host's model depends on it. Every score carries
a one-line reason of at most 160 characters that states the evidence, without a path, a secret, or a
second sentence.

Pass the scores as the `significance` object to `discover_significance_stage`, beside the
glossaries, with exactly this shape:

```json
{
  "schemaVersion": 1,
  "contexts": {
    "<boundedContext>": {
      "<concept-id>": { "score": 0, "reason": "One line of evidence." }
    }
  }
}
```

- `schemaVersion: 1` is the only schema version; write no other top-level key.
- `contexts` names exactly the staged bounded contexts and nothing else. Each context names exactly
  that glossary's concept ids and nothing else.
- Each entry carries exactly `score` and `reason`. `score` is an integer from `0` to `100`; `reason`
  is one line of at most 160 characters, is not empty, and contains no absolute path and no secret.
- Every glossary concept has a significance score. A missing entry, an extra entry, a score outside
  the range, or a rejected reason fails the run, so never stage a partial sidecar.
- Exclude significance from the glossary YAML: no concept carries a score or a reason field.

## Glossary skill

Call `discover_skill_stage` with `name` set to `discover-glossary`, `description` set to one
sentence naming the project's glossary policy and when to apply it, and `body` set to a `#`
heading title followed only by imperative bullets. The tool writes the managed frontmatter.

- `name` is exactly `discover-glossary`; `description` is non-empty and at most 1024 characters.
- The body is a `#` heading title followed only by imperative bullets, one directive per bullet.
  Every non-empty, non-heading line starts with `- `. No paragraphs, tables, prose introduction, or
  chat report.
- Do not name a source, test, manifest, or CI file or directory in a bullet. State the rule and
  the convention it applies to directly. An exact command is allowed even when it contains a path.
  Never append a path in parentheses to show where a claim was derived.
- Never say where a rule was observed, and carry no evidence clause (`Evidence:`, `See`, `found in`,
  `declared in`). The published glossary is a harness artifact, not host source, so naming it is
  allowed and required here.
- The skill must name every glossary file at its published path
  `.omp/discover/glossary/<bounded-context>.glossary.yaml`, one bullet per bounded context, using
  the same bounded-context ids the staged glossaries carry.
- The skill must state the confirmed and rejected term rules, the proposal process, and that no
  generated file carries a confirmed status.

## Before you stop

Confirm all of the following:

- [ ] Every `discover_glossary_stage` call returned a path; the document parses as YAML, has the
      required top-level and concept keys in order, unique kebab-case ids, at least one concept,
      an English preferred label and definition per concept, and at least one valid grounding per
      concept.
- [ ] Every concept is `unconfirmed` or `proposed`; every `origin: standard` has a `standardRef`;
      no confirmed, deprecated, or invalidated status appears.
- [ ] `discover_significance_stage` returned its path, and every staged glossary concept carries a
      significance score in it: one integer from `0` to `100` and a one-line reason, with no
      missing, extra, or unscored entry.
- [ ] `discover_skill_stage` returned its path with the exact name, a non-empty description of
      at most 1024 characters, a heading plus imperative bullets, and one bullet per bounded
      context naming its published glossary path.
- [ ] No staged file contains an absolute path, a secret value, a URL with user info, a paragraph,
      a timestamp, or a run id.
- [ ] Nothing was written outside `<staging-dir>`; `GOAL.md`, `adrs/`, host source, `.omp/discover`,
      and `.omp/skills` are untouched.
- [ ] No question was asked and no project command, test, build, install, fetch, or forge query was
      run.

Reply with nothing. The staged files are the result.
