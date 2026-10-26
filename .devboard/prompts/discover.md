---
description: Crawl the host read-only and stage an evidence-backed project sheet, one UbiLang glossary per bounded context, and five project-specific Discover Agent Skills.
---

`/discover <staging-dir>`: crawl the host read-only, then write a staged Discover result that the
server validates and publishes. This turn produces data, not conversation: no interview, no
questions, no prose report.

## Contract

- `<host>` is the git top level: `git rev-parse --show-toplevel`. If that fails, use the current
  working directory.
- `<staging-dir>` is the single argument after `/discover` (`$ARGUMENTS` in the wrapper). It is the
  only directory this turn may write. Create the subdirectories named below; create nothing else.
- The server owns publication. Never write outside `<staging-dir>`, and never touch
  `<host>/.omp/discover/`, `<host>/.omp/skills/`, `<host>/GOAL.md`, anything under
  `<host>/adrs/`, or any host source file.
- Never write `manifest.json` or `decisions.json`; the server generates both. The staged sheet has
  no `freshness` key; the server injects freshness on publication.
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

Read only what you need, and prefer breadth first so the sheet describes the whole host.

1. Inventory the git top level with `git ls-files` and `git status`; note the default branch with
   `git branch` and recent history with `git log` when it supports a claim.
2. Read `README`, `AGENTS.md`, `GOAL.md`, and `adrs/` when present. They are evidence and context
   only: never edit them and never copy their prose into a value.
3. Read manifests, lockfile metadata without dependency contents, task-runner files, configuration,
   CI configuration, container and deployment descriptors, and documentation that names runtime,
   build, test, release, or environment facts.
4. Read source and tests to locate contexts, entry points, dependency direction, conventions, test
   levels, fixtures, and domain terms. Read ignored files never. Read dependency caches, vendored
   third-party trees, build outputs, and generated artifacts never.
5. Exclude from the crawl entirely: `<host>/.devboard/`, `<host>/.worktree/`, `<host>/.git/`
   internals, every path under `<host>/.omp/`, package manager and tool caches, virtual
   environments, build and coverage outputs, and every ignored path. Do not cite an excluded path
   as evidence.
6. Do not open files that plainly hold secrets, such as environment value files, keystores, or
   credential stores. Environment names and configuration keys may be recorded from manifests,
   templates, descriptors, and documentation; their values never.

Never block on an ambiguity and never ask a question. When the evidence is absent, contradictory,
or insufficient, write `unknown` with a short reason. Never guess, fill a plausible value, or
invent a path, command, environment, context, or term.

## Staged layout

Write exactly this layout under `<staging-dir>`:

```
sheet.json
glossary/<boundedContext>.glossary.yaml
glossary/significance.json
skills/<skill-name>/SKILL.md
```

- `sheet.json` is one JSON object with no freshness key.
- Write at least one glossary file. The file name is the bounded-context id in kebab case; at least
  one bounded context must be detected.
- Write exactly one `SKILL.md` for each of the five fixed names below and no other skill directory.
- Write no other files, no notes, no logs, and no temporary files. Order every object key, array,
  and enum exactly as specified so two crawls of unchanged input produce the same structural
  digest apart from deliberately bounded prose.

## `sheet.json`

Write these top-level keys in this canonical order:

```
schemaVersion, definition, stack, deployment, environments, commands, branching,
testing, architecture, ci, runtime, dependencyMap, delivery
```

`schemaVersion` is the integer `1`.

Every value below is a **leaf**:

```json
{
  "value": null,
  "evidence": [],
  "confidence": "unknown",
  "reason": "short reason"
}
```

- `value` is the fact, or `null` exactly when `confidence` is `unknown`.
- `evidence` is a sorted, de-duplicated list of repository-relative paths, symbol anchors, or safe
  read-only git facts. No leading `/`, no `..`, no drive letter, no absolute path, no URL. A
  non-`unknown` leaf needs at least one evidence entry and carries at most 32 entries.
- `confidence` is exactly one of `observed` (read directly), `declared` (stated by the project's
  own documentation or configuration), `inferred` (supported but not stated), or `unknown`.
- `reason` is required and short (at most 200 characters) when `confidence` is `unknown`; it is
  omitted otherwise.
- Every string value and every string inside a list value is non-empty and one line of at most 160
  characters. No value is a paragraph, a sentence fragment copied from documentation, or a secret.
  A list carries at most 64 entries.
- Lists are sorted by their first string. A leaf whose fact does not exist is `unknown` with
  `"value": null` and a reason; it is never an empty guess. `environments` is the exception and
  always carries at least the production entry described below.

Sections and required keys:

```jsonc
{
  "schemaVersion": 1,
  "definition": { "value": "Short one-sentence project definition of at most 240 characters.", "evidence": ["README.md"], "confidence": "declared" },
  "stack": { "value": ["one technology per entry"], "evidence": ["path"], "confidence": "declared" },
  "deployment": {
    "class": { "value": "package|container|static-site|service|cli|library|plugin|none", "evidence": ["path"], "confidence": "observed" },
    "artifact": { "value": "artifact name", "evidence": ["path"], "confidence": "observed" },
    "target": { "value": "target or registry", "evidence": ["path"], "confidence": "declared" },
    "pipelineSources": { "value": ["path"], "evidence": ["path"], "confidence": "observed" }
  },
  "environments": { "value": [{ "name": "environment name", "purpose": "short purpose" }], "evidence": ["path"], "confidence": "declared" },
  "commands": {
    "install": { "value": "exact command", "evidence": ["path"], "confidence": "declared" },
    "build": { "value": "exact command", "evidence": ["path"], "confidence": "declared" },
    "test": { "value": "exact command", "evidence": ["path"], "confidence": "declared" },
    "lint": { "value": "exact command", "evidence": ["path"], "confidence": "declared" },
    "typecheck": { "value": "exact command", "evidence": ["path"], "confidence": "declared" },
    "dev": { "value": "exact command", "evidence": ["path"], "confidence": "declared" },
    "tryOut": { "value": "exact command", "evidence": ["path"], "confidence": "declared" },
    "release": { "value": "exact command", "evidence": ["path"], "confidence": "declared" }
  },
  "branching": {
    "defaultBranch": { "value": "branch name", "evidence": ["git branch"], "confidence": "observed" },
    "mergeMethod": { "value": "merge method", "evidence": ["git log", "path"], "confidence": "inferred" },
    "releaseBranches": { "value": ["branch name"], "evidence": ["git branch"], "confidence": "observed" },
    "model": { "value": "direct|pull-request|git-flow", "evidence": ["git log"], "confidence": "inferred" }
  },
  "testing": {
    "levels": { "value": [{ "level": "unit|integration|end-to-end|contract|other", "tests": "exact test count", "paths": ["path"], "command": "exact command or unknown", "fixtures": ["path"] }], "evidence": ["path"], "confidence": "observed" },
    "pyramid": { "value": "short pyramid description", "evidence": ["path"], "confidence": "inferred" }
  },
  "architecture": {
    "contexts": { "value": [{ "name": "context name", "path": "repo-relative path", "responsibility": "short responsibility", "entryPoints": ["repo-relative path"] }], "evidence": ["path"], "confidence": "observed" },
    "dependencyDirection": { "value": "short direction statement", "evidence": ["path"], "confidence": "inferred" },
    "externalBoundaries": { "value": ["boundary"], "evidence": ["path"], "confidence": "observed" },
    "sharedKernels": { "value": ["kernel and path"], "evidence": ["path"], "confidence": "observed" }
  },
  "ci": {
    "provider": { "value": "provider or none detected", "evidence": ["path"], "confidence": "observed" },
    "triggers": { "value": ["trigger"], "evidence": ["path"], "confidence": "observed" },
    "jobs": { "value": ["job name"], "evidence": ["path"], "confidence": "observed" },
    "qualityGates": { "value": ["required gate"], "evidence": ["path"], "confidence": "declared" },
    "artifacts": { "value": ["artifact"], "evidence": ["path"], "confidence": "observed" }
  },
  "runtime": {
    "languages": { "value": ["language plus version"], "evidence": ["path"], "confidence": "observed" },
    "runtimes": { "value": ["runtime and version"], "evidence": ["path"], "confidence": "declared" },
    "packageManagers": { "value": ["package manager"], "evidence": ["path"], "confidence": "observed" },
    "versions": { "value": ["pinned version fact"], "evidence": ["path"], "confidence": "observed" },
    "manifests": { "value": ["repo-relative manifest path"], "evidence": ["path"], "confidence": "observed" }
  },
  "dependencyMap": {
    "binaries": { "value": ["binary"], "evidence": ["path"], "confidence": "observed" },
    "packages": { "value": ["package"], "evidence": ["path"], "confidence": "observed" },
    "routes": { "value": ["route"], "evidence": ["path"], "confidence": "observed" },
    "jobs": { "value": ["job"], "evidence": ["path"], "confidence": "observed" },
    "externalServices": { "value": ["service"], "evidence": ["path"], "confidence": "observed" },
    "dataStores": { "value": ["store"], "evidence": ["path"], "confidence": "observed" },
    "keyDependencies": { "value": ["dependency"], "evidence": ["path"], "confidence": "declared" }
  },
  "delivery": {
    "artifactTarget": { "value": "registry or artifact target", "evidence": ["path"], "confidence": "declared" },
    "releaseChannels": { "value": ["channel"], "evidence": ["path"], "confidence": "declared" },
    "versionScheme": { "value": "scheme", "evidence": ["path"], "confidence": "declared" },
    "migrationPolicy": { "value": "policy or none detected", "evidence": ["path"], "confidence": "declared" }
  }
}
```

Section rules:

- `definition` is exactly one sentence of at most 240 characters, ends with `.`, and describes what
  the project is for its users. It is not a copy of the README's opening paragraph.
- `stack` is the short platform list: languages, runtimes, package managers, frameworks, and major
  tools actually used to build or run the project. Do not list individual third-party
  dependencies; those belong in `dependencyMap.keyDependencies`.
- `deployment.class` uses the fixed enum; use `none` when the host publishes nothing, and
  `value: null` with `confidence: unknown` when the class is undetermined. Only the confidence can
  be `unknown`; the literal string `unknown` is not an enum value.
- `environments` always records at least one entry. Record every environment name found in
  manifests, configuration, container files, CI configuration, and deployment descriptors, with
  its short purpose. When no other environment is evidenced, record exactly one `production`
  entry whose purpose states how changes reach it, such as a direct push or a published package.
  A source path belongs in `evidence`; never invent additional environments.
- `commands` repeats the exact install, build, test, lint, typecheck, dev/run, try-out, and release
  command found in a manifest, task runner, CI file, or documentation. `test` is the one command
  that runs the whole suite. `tryOut` starts or opens the project for a hands-on try — a dev
  server, a demo entry point, or an example invocation — and is never the test command; when the
  crawl found no such command, write `unknown`. A command the crawl did not observe is `unknown`;
  never execute it and never reconstruct it from another ecosystem's habit.
- `branching` reports the observed default branch and release branches, the observed or inferred
  merge method, and one of `direct`, `pull-request`, or `git-flow`, supported by git and CI
  evidence. A model the repository does not evidence is `value: null` with `confidence: unknown`
  and a reason.
- `testing` reports the observed test levels, an exact test count for each level, representative
  paths, commands, fixtures, and the resulting pyramid. Count the test cases you can see statically
  in the test files; never run the suite. A level with evidence but no test case is `0`; a level
  with no evidence is omitted. Never write `unknown` as a count.
- `architecture` reports detected bounded contexts or modules with path and responsibility, entry
  points, allowed dependency direction, external boundaries, and shared kernels. `ci` reports
  provider, triggers, jobs, required quality gates, and artifacts; with no CI configuration use
  `none detected`, never invented jobs.
- `runtime`, `dependencyMap`, and `delivery` are mandatory cards. Report languages, runtimes,
  package managers, versions, and manifests; binaries, packages, routes, jobs, external services,
  data stores, and key dependencies; artifact target, release channels, version scheme, and
  migration policy.

## Glossary (UbiLang)

Write one YAML document per detected bounded context at
`glossary/<boundedContext>.glossary.yaml`. It must be a complete, parseable UbiLang glossary.

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
- `grounding` is a non-empty list. Each entry is `code:<repository-relative path that exists>` or
  `model:<symbol or model name that appears in the crawled host>`. The `model:` name matches
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

Before writing glossaries, read the currently published
`<host>/.omp/discover/glossary/` and `<host>/.omp/discover/decisions.json` when present, read-only.
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

Stage the scores at `glossary/significance.json`, beside the glossaries, with exactly this shape:

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

The five generated skills name no concept absent from the glossary and no generic label the
glossary omits. When a skill describes a rule about a term, that term appears in the glossary with
its score.

## Discover skills

Write exactly these five directories, each with one `SKILL.md`:

```
discover-testing-strategy
discover-naming-conventions
discover-coding-conventions
discover-architecture-boundaries
discover-glossary
```

Frontmatter, in this shape:

```yaml
---
name: discover-<role>
description: One sentence naming the project-specific policy and when to apply it.
metadata:
  devboard-managed: "true"
  devboard-family: "discover"
  devboard-skill: <role>
---
```

- `name` equals the directory name, matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`, and is at most 64
  characters. `description` is non-empty and at most 1024 characters. Neither marker may be
  omitted; `devboard-managed` is the quoted string `"true"`.
- The body is a `#` heading title followed only by imperative bullets, one directive per bullet.
  Every non-empty, non-heading line starts with `- `. No paragraphs, tables, prose introduction, or
  chat report.
- Do not name a source, test, manifest, or CI file or directory in a bullet. State the rule and
  the convention it applies to directly; the sheet and its evidence already carry the provenance.
  An exact command is allowed even when it contains a path. Never append a path in parentheses to
  show where a claim was derived.
- When a previously published generated baseline exists under
  `<host>/.omp/discover/skills/<name>/SKILL.md`, read it for continuity of scope and structure.
  Always regenerate from the current crawl. Never copy a developer's live edits into the baseline;
  the server preserves edited live skills byte for byte, replaces an unedited live skill with the
  new baseline, and never recreates a deleted one. Write the generated baseline as if every live
  skill were unedited.

Content each skill must carry:

- **discover-testing-strategy**: the levels actually present, the test pyramid, exact commands,
  fixture roles, coverage expectations, and how to add a test for a change.
- **discover-naming-conventions**: canonical domain terms, casing for files, modules, types,
  functions, errors, and flags, and rejected aliases.
- **discover-coding-conventions**: observed patterns, error handling, typing, async style, logging,
  dependency use, formatting and linting, and prohibited constructs.
- **discover-architecture-boundaries**: bounded contexts, entry points, dependency direction,
  persistence, integrations, and prohibited cross-boundary imports.
- **discover-glossary**: the canonical glossary directory, the confirmed and rejected term
  rules, and the proposal process.

All five baselines must be internally consistent and consistent with the glossary. Never recommend
an invalidated concept's preferred label. If two generated bullets would contradict, rewrite them
so both give compatible instructions.

## Determinism

Two crawls of the same unchanged host MUST produce the same structural digest. A digest that moves
is a defect in the crawl, so follow these rules mechanically and do not re-derive a leaf from
different evidence between crawls.

- Use the fixed key orders above; sort every list of facts by its stable identity key; sort and
  de-duplicate evidence; write enum values in their fixed spelling.
- Cite exactly one evidence entry per non-unknown leaf, never several. When more than one file
  supports the fact, take the first that exists in this fixed order: the manifest or task-runner
  file, then the CI or deployment descriptor, then configuration, then `README`/`AGENTS.md`/
  `GOAL.md`/`adrs/`, then source, then tests. A list value's single evidence is the file that
  declares every entry in it.
- Copy each free-text value verbatim from its cited file and keep the shortest exact fragment that
  states the fact. Do not paraphrase, expand a version, or merge two files into one cell.
- Derive confidence by this table and nothing else:
  - `observed` when the value appears verbatim in the cited file under a matching key or line;
  - `declared` when the cited file states the fact in prose or a task name;
  - `inferred` only when the cited git facts support it without stating it;
  - `unknown` when no cited file states or supports it.
- Apply these fixed rules, so the same files always yield the same value:
  - `deployment.class`: `container` only for a container file; `static-site` only for a static
    build output; `service` only for a server entry point; `cli` only for a `bin` field;
    `library` only for a `main`/`types` field with no `bin`; `package` only for a manifest that
    publishes a package; `plugin` only for a plugin manifest; otherwise `none`, `observed`.
  - `deployment.pipelineSources`: the CI/deployment file paths only when one of them carries a
    publish, package, or deploy step; otherwise `unknown`.
  - `branching.model`: `pull-request` only when CI triggers on `pull_request` or
    `merge_request`; `git-flow` only when both a `develop` branch and a `release/*` branch exist;
    `direct` only when CI has no review trigger and `git log` shows a linear default branch;
    otherwise `unknown` with a reason.
  - `testing.levels`: include a level only when a file path or command proves it; a level with no
    evidence is omitted, never written with `tests: "0"`.
- When reading `git status`, ignore every path under `.omp/`: those are this feature's published
  artifacts, not host facts.
- Write no timestamp, run id, publication time, fingerprint, or machine-specific value. The server
  injects freshness and computes the structural digest.
- Keep bounded prose (the definition, titles, definitions, scope notes, history notes, and unknown
  reasons) natural, but keep every fact, list, path, enum, and id identical for unchanged input.

## Before you stop

Confirm all of the following:

- [ ] `<staging-dir>/sheet.json` exists, parses, has no `freshness` key, has every top-level key
      in canonical order, and has every section and leaf required above.
- [ ] The definition is one sentence of at most 240 characters and ends with `.`.
- [ ] Every string value and list entry is a non-empty single line of at most 160 characters;
      every `unknown` leaf other than `environments` has a null value, empty evidence, and a
      reason; every known leaf has at least one repo-relative evidence entry; `environments`
      carries at least the production entry.
- [ ] No staged file contains an absolute path, a secret value, a URL with user info, a paragraph,
      a timestamp, or a run id.
- [ ] At least one `glossary/<boundedContext>.glossary.yaml` exists, parses as YAML, has the
      required top-level and concept keys in order, unique kebab-case ids, at least one concept,
      an English preferred label and definition per concept, and at least one valid grounding per
      concept.
- [ ] Every concept is `unconfirmed` or `proposed`; every `origin: standard` has a `standardRef`;
      no confirmed, deprecated, or invalidated status appears.
- [ ] `glossary/significance.json` exists beside the glossaries and every staged glossary concept
      carries a significance score in it: one integer from `0` to `100` and a one-line reason,
      with no missing, extra, or unscored entry.
- [ ] No generic label the glossaries omit is named by a generated skill, and every concept a
      generated skill names appears in the glossary.
- [ ] All five `skills/<name>/SKILL.md` files exist with matching names, non-empty descriptions of
      at most 1024 characters, and both markers; each body is a heading plus imperative bullets,
      and no bullet names a source, test, manifest, or CI path.
- [ ] The five baselines do not contradict each other or the glossary, and no skill recommends an
      invalidated label.
- [ ] Nothing was written outside `<staging-dir>`; `GOAL.md`, `adrs/`, host source, `.omp/discover`,
      and `.omp/skills` are untouched.
- [ ] No question was asked and no project command, test, build, install, fetch, or forge query was
      run.

Reply with nothing. The staged files are the result.
