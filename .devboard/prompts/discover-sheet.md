---
description: Crawl the host read-only and stage the Discover project sheet as one evidence-backed JSON document.
---

## Manifesto

Your goal is to give the host one accurate, evidence-backed picture of itself, and the observable
result is the run's staged project sheet written through the Devboard MCP sheet-staging tool and
then published by the server.

## Contract

- `<host>` is the git top level: `git rev-parse --show-toplevel`. If that fails, use the current
  working directory.
- `<staging-dir>` is the run's staging directory, passed to every staging tool call. The tools are
  the only writers; never create or edit a staged file by hand.
- The server owns publication. Never write outside the run's staging directory, and never touch
  `<host>/.omp/discover/`, `<host>/.omp/skills/`, `<host>/GOAL.md`, anything under `<host>/adrs/`,
  or any host source file.
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
7. You may read the published `<host>/.omp/discover/sheet.json` and
   `<host>/.omp/discover/glossary/` when they exist as optional reference; nothing in this turn
   depends on them, and you never copy from them into a value.

Never block on an ambiguity and never ask a question. When the evidence is absent, contradictory,
or insufficient, write `unknown` with a short reason. Never guess, fill a plausible value, or
invent a path, command, environment, context, or term.

## Staging

Call `discover_sheet_stage` exactly once with `stagingDir` set to `<staging-dir>` and `sheet` set
to the complete object below. The tool writes the run's staged project sheet and returns its path
and schema version. Write no glossary, no skill, no notes, no logs, and no temporary files. Order
every object key, array, and enum exactly as specified so two crawls of unchanged input produce
the same structural digest apart from deliberately bounded prose.

## `sheet`

The `sheet` object carries these top-level keys in this canonical order:

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
  always carries at least the production entry described below; `architecture.externalBoundaries`
  is the other exception and stages an observed empty list, as the External boundaries section
  states.

Sections and required keys:

```jsonc
{
  "schemaVersion": 1,
  "definition": { "value": "Short one-sentence project definition of at most 240 characters.", "evidence": ["README.md"], "confidence": "declared" },
  "stack": { "value": ["one technology name per entry, no version"], "evidence": ["path"], "confidence": "declared" },
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
    "levels": { "value": [{ "level": "unit|integration|end-to-end|contract|other", "tests": "exact test count", "happyPath": "exact happy-path test count", "paths": ["path"], "command": "declared command", "fixtures": ["path"] }], "evidence": ["path"], "confidence": "observed" },
    "pyramid": { "value": "short pyramid description", "evidence": ["path"], "confidence": "inferred" }
  },
  "architecture": {
    "contexts": { "value": [{ "name": "context name", "path": "repo-relative path", "responsibility": "short responsibility", "entryPoints": ["repo-relative path"] }], "evidence": ["path"], "confidence": "observed" },
    "dependencies": { "value": [{ "from": "context name", "to": "context name" }], "evidence": ["path"], "confidence": "observed" },
    "dependencyDirection": { "value": "short direction statement", "evidence": ["path"], "confidence": "inferred" },
    "externalBoundaries": { "value": ["external system"], "evidence": ["path"], "confidence": "observed" },
    "sharedKernels": { "value": ["kernel and path"], "evidence": ["path"], "confidence": "observed" }
  },
  "ci": {
    "provider": { "value": "provider or none detected", "evidence": ["path"], "confidence": "observed" },
    "triggers": { "value": ["trigger"], "evidence": ["path"], "confidence": "observed" },
    "jobs": { "value": ["job name"], "evidence": ["path"], "confidence": "observed" },
    "qualityGates": {
      "value": [{ "name": "required gate", "checks": "what the gate checks, in one short line" }],
      "evidence": ["path"], "confidence": "declared"
    },
    "artifacts": { "value": ["artifact"], "evidence": ["path"], "confidence": "observed" }
  },
  "runtime": {
    "languages": { "value": ["language name"], "evidence": ["path"], "confidence": "observed" },
    "runtimes": { "value": ["runtime name"], "evidence": ["path"], "confidence": "declared" },
    "packageManagers": { "value": ["package manager"], "evidence": ["path"], "confidence": "observed" },
    "versions": { "value": ["pinned version fact"], "evidence": ["path"], "confidence": "observed" },
    "manifests": { "value": ["repo-relative manifest path"], "evidence": ["path"], "confidence": "observed" }
  },
  "dependencyMap": {
    "binaries": { "value": ["binary"], "evidence": ["path"], "confidence": "observed" },
    "packages": { "value": ["package"], "evidence": ["path"], "confidence": "observed" },
    "routes": { "value": ["route path such as /orders"], "evidence": ["path"], "confidence": "observed" },
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
  tools actually used to build or run the project. Each entry is the bare technology name, without a
  version number or a version constraint: write `PostgreSQL`, not `PostgreSQL 15`. Pinned versions
  belong to `runtime.versions`. Do not list individual third-party dependencies; those belong in
  `dependencyMap.keyDependencies`.
- `dependencyMap.routes` records one HTTP route per entry as its path, beginning with `/`, and
  optionally the method, such as `/orders` or `GET /orders/:id`. The leading slash belongs to the
  route; it is not an absolute host path.
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
  An alias is not a separate command. When a candidate resolves to another recorded command —
  `npm test` declared as `node --test test/*.test.js`, or a script that only wraps the test,
  build, lint, typecheck, or release command — it is that command under another name and must not
  be recorded as `tryOut`. Write `tryOut` only for a command that starts, serves, or opens the
  project for hands-on use and that no other recorded command subshells into. When the only
  candidate is an alias, or the crawl cannot tell whether it is one, stage `tryOut` as `unknown`
  with a reason; never guess a try-out command from a test runner, a demo script name, or the
  ecosystem's habit.
  Record the invocation a developer would type, not the program a script expands to. When
  `package.json` declares `scripts.test`, `commands.test` is `npm test` and `evidence` names
  `package.json`; when it declares a script for one level (`test:unit`, `test:contract`), that
  level's `command` is `npm run <script>`. Only without a declared script does the command become
  the program the manifest or CI file invokes.
- `branching` reports the observed default branch and release branches, the observed or inferred
  merge method, and one of `direct`, `pull-request`, or `git-flow`, supported by git and CI
  evidence. A model the repository does not evidence is `value: null` with `confidence: unknown`
  and a reason.
- `testing` reports the observed test levels, an exact test count for each level, representative
  paths, commands, fixtures, and the resulting pyramid. Count the test cases you can see statically
  in the test files; never run the suite. A level with evidence but no test case is `0`; a level
  with no evidence is omitted. Never write `unknown` as a count.
  `happyPath` is the part of that level's count that exercises the primary success path — the
  expected input reaching the expected outcome with no error or edge branch — judged from test
  names, fixtures, and assertions. It is an exact count from `0` to `tests`, never a percentage
  and never `unknown`. A level whose tests are all error, negative, or boundary cases records `0`.
  `command` is the narrowest declared invocation that runs only that level, such as
  `npm run test:unit`, `pytest tests/unit`, or `cargo test --test contract`; when the level has no
  separate entry point, it is the whole-suite invocation.
- `architecture` reports detected bounded contexts or modules with path and responsibility, entry
  points, the directed dependencies between them, allowed dependency direction, shared kernels, and
  `externalBoundaries`, which carries external systems only and never internal architecture.
  `dependencies` records one `{ from, to }` entry per edge where the context named `from` imports,
  calls, or otherwise reaches the context named `to`; both names are contexts in this same sheet,
  `from` is never `to`, and one edge appears once. Record an edge only when a file in the source
  proves it; a project whose contexts never reach each other records `[]` with `confidence:
  observed` and evidence naming the context paths, and a crawl that cannot determine the edges
  records `unknown` with a reason. `ci` reports provider, triggers, jobs,
  required quality gates, and artifacts; with no CI configuration use `none detected`, never
  invented jobs. A quality gate is one required check with its name and a `checks` line that says
  what the gate verifies, such as `pre-commit` checking formatting and lint on staged files. Ground
  that line in the gate's configuration, hook id, or script; keep it to one short sentence and never
  list checks the configuration does not name.
- `runtime`, `dependencyMap`, and `delivery` are mandatory cards. Report languages, runtimes,
  package managers, versions, and manifests; binaries, packages, routes, jobs, external services,
  data stores, and key dependencies; artifact target, release channels, version scheme, and
  migration policy. `languages` and `runtimes` carry the bare name, without a version number or a
  version constraint; every pinned version belongs to `runtime.versions`.

## External boundaries

`architecture.externalBoundaries` names external systems only. It is the one architecture leaf with
a rule of its own, and that rule overrides the general empty-list rule above.

- An external boundary is an external system the host integrates with across its own process and
  artifact: a remote API or service, a message broker, a database, an identity provider, or an
  external tool the host does not ship. Name the external system, not the module or primitive that
  reaches it, and stage that system's own name.
- Language and runtime built-ins are never a boundary. `node:child_process`, `node:worker_threads`,
  and the other concurrency primitives and standard-library modules a runtime ships describe
  internal architecture: they start, schedule, or coordinate the host's own work inside its own
  process and artifact. A language built-in, a standard-library type, an operating-system facility,
  and a concurrency primitive are each never a boundary.
- A name that is not verbatim in a cited file comes from the host's own configuration,
  documentation, or constant: the host name or endpoint its code calls, the client library it
  imports, or the identifier it declares. Never name a system from the usual stack of the
  ecosystem, from habit, or by rewriting a domain out of a path. Two crawls of unchanged input
  therefore stage the same entry.
- `architecture.externalBoundaries is the one leaf that stages an empty observed list`: when the
  host integrates with no external system, write `"value": []` with `confidence: observed` and at
  least one evidence entry naming the files that prove the absence, never `unknown` and never an
  invented entry.

Examples:

- A module that spawns the host's own worker script and subprocesses through `node:child_process`
  and `node:worker_threads`: no boundary, because both are runtime built-ins.
- A module that calls `fetch("https://api.openweathermap.org/data/2.5/weather")` for weather:
  `api.openweathermap.org`, the external system.
- A service that reads and writes through a Postgres driver: `PostgreSQL`, the external system.

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
  states the fact. Do not paraphrase, expand a version, or merge two files into one cell. The
  name-only entries above — `stack`, `runtime.languages`, and `runtime.runtimes` — drop the version
  or constraint their cited file declares.
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
- Keep bounded prose (the definition and unknown reasons) natural, but keep every fact, list, path,
  enum, and id identical for unchanged input.

## Before you stop

Confirm all of the following:

- [ ] `discover_sheet_stage` returned the staged sheet path and the sheet parses, has no
      `freshness` key, has every top-level key in canonical order, and has every section and leaf
      required above.
- [ ] The definition is one sentence of at most 240 characters and ends with `.`.
- [ ] Every string value and list entry is a non-empty single line of at most 160 characters;
      every `unknown` leaf other than `environments` has a null value, empty evidence, and a
      reason; every known leaf has at least one repo-relative evidence entry; `environments`
      carries at least the production entry.
- [ ] `architecture.externalBoundaries` names external systems only: each entry is an external
      system, no runtime built-in, `node:` module, or concurrency primitive appears, and a host with
      none stages `[]` with `confidence: observed` and evidence.
- [ ] Every `architecture.dependencies` entry names one context in `from` and one in `to`, never the
      same context twice in an edge, never repeats an edge, and is grounded in a source file.
- [ ] `commands.tryOut` is either a hands-on entry point that no recorded command aliases, or
      `unknown`: it never repeats, wraps, or aliases install, build, test, lint, typecheck,
      dev/run, or release.
- [ ] No staged file contains an absolute path, a secret value, a URL with user info, a paragraph,
      a timestamp, or a run id.
- [ ] Nothing was written outside `<staging-dir>`; `GOAL.md`, `adrs/`, host source, `.omp/discover`,
      and `.omp/skills` are untouched.
- [ ] No question was asked and no project command, test, build, install, fetch, or forge query was
      run.

Reply with nothing. The staged file is the result.
