---
description: Crawl the host read-only and stage the project's naming-conventions Discover skill.
---

## Manifesto

Your goal is to record how this project names things, and the observable result is the run's
staged naming-conventions Discover skill written through the Devboard MCP skill-staging tool and
then published by the server.

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

Read only what you need, so the skill states the naming policy the host actually follows.

1. Inventory the git top level with `git ls-files` and `git status`.
2. Read source, tests, and documentation to establish the casing used for files, modules, types,
   functions, constants, errors, flags, environment variables, and public identifiers.
3. Read the domain model, routes, and documentation for the project's own compound terms, and note
   which terms are rejected aliases of a canonical one.
4. Exclude from the crawl entirely: `<host>/.devboard/`, `<host>/.worktree/`, `<host>/.git/`
   internals, every path under `<host>/.omp/`, package manager and tool caches, virtual
   environments, build and coverage outputs, and every ignored path. Do not cite an excluded path
   as evidence.
5. Do not open files that plainly hold secrets, such as environment value files, keystores, or
   credential stores.
6. When present, you may read the published `<host>/.omp/discover/sheet.json` and
   `<host>/.omp/discover/glossary/` as optional reference for the canonical terms and the detected
   contexts. Nothing in this turn depends on them: when they are absent, derive the terms from the
   host itself.

Never block on an ambiguity and never ask a question. When the evidence is absent or insufficient,
state the casing rule the host plainly follows and omit the rest. Never invent a term, an alias, a
path, or a convention.

## Skill

Call `discover_skill_stage` once with `stagingDir` set to `<staging-dir>`, `name` set to
`discover-naming-conventions`, `description` set to one sentence naming the project-specific
naming policy and when to apply it, and `body` set to a `#` heading title followed only by
imperative bullets. The tool writes the managed frontmatter and the staged skill.

- `name` is exactly `discover-naming-conventions`; `description` is non-empty and at most 1024
  characters.
- The body is a `#` heading title followed only by imperative bullets, one directive per bullet.
  Every non-empty, non-heading line starts with `- `. No paragraphs, tables, prose introduction, or
  chat report.
- Do not name a source, test, manifest, or CI file or directory in a bullet. State the rule and
  the convention it applies to directly. An exact command is allowed even when it contains a path.
  Never append a path in parentheses to show where a claim was derived.
- Never say where a rule was observed. A bullet carries no evidence clause (`Evidence:`, `See`,
  `found in`, `declared in`), no file or directory name in any form — bare, backticked, quoted, or
  in parentheses — and no path outside an exact command. A manifest such as `package.json`, a CI
  descriptor, a test path, or a configuration file is provenance and never policy.
- Prefer four to eight bullets. When a previously published generated baseline exists under
  `<host>/.omp/discover/skills/discover-naming-conventions/SKILL.md`, read it for continuity of
  scope and structure and regenerate from the current crawl.

Content the skill must carry:

- The canonical domain terms and the casing each kind of identifier uses.
- The file, module, type, function, error, and flag naming rules the host follows.
- The aliases and synonyms the project rejects, and which canonical term replaces each one.
- Never recommend an invalidated or rejected term from the published glossary. When a skill
  describes a rule about a domain term, that term must appear in the glossary with its score; a
  rule about generic vocabulary the glossary omits names no concept.

## Determinism

Two crawls of the same unchanged host MUST produce the same skill apart from bounded prose. Use the
same headings, the same order, and the same exact commands; sort any list by its stable identity
key. Write no timestamp, run id, fingerprint, or machine-specific value.

## Before you stop

Confirm all of the following:

- [ ] `discover_skill_stage` returned the staged path and no other file was staged.
- [ ] The staged skill carries the exact name, a non-empty description of at most 1024 characters,
      and both managed markers with `devboard-family` set to `discover`.
- [ ] The body is one `#` heading plus imperative `- ` bullets; no bullet names a source, test,
      manifest, or CI path or cites where a rule was observed.
- [ ] Each rule is grounded in observed host usage, and every rejected alias has a canonical term.
- [ ] No concept named by the skill is absent from the published glossary, and no invalidated
      label is recommended.
- [ ] Nothing was written outside `<staging-dir>`; `GOAL.md`, `adrs/`, host source, `.omp/discover`,
      and `.omp/skills` are untouched.
- [ ] No question was asked and no project command, test, build, install, fetch, or forge query was
      run.

Reply with nothing. The staged file is the result.
