---
description: Crawl the host read-only and stage the project's coding-conventions Discover skill.
---

`/discover-coding-conventions <staging-dir>`: crawl the host read-only, then write one staged
Discover skill that records how this project writes code. This turn produces data, not
conversation: no interview, no questions, no prose report.

## Contract

- `<host>` is the git top level: `git rev-parse --show-toplevel`. If that fails, use the current
  working directory.
- `<staging-dir>` is the single argument after `/discover-coding-conventions` (`$ARGUMENTS` in the
  wrapper). It is the only directory this turn may write. Write exactly
  `skills/discover-coding-conventions/SKILL.md` inside it and create nothing else.
- The server owns publication. Never write outside `<staging-dir>`, and never touch
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

Read only what you need, so the skill states the coding policy the host actually follows.

1. Inventory the git top level with `git ls-files` and `git status`.
2. Read source and tests across more than one area, so a rule describes the project rather than one
   file: typing, error handling, async style, logging, dependency use, formatting, linting, and
   prohibited constructs.
3. Read the manifests, task-runner files, and linter or formatter configuration to find the exact
   commands the project declares and the rules it enforces mechanically.
4. Exclude from the crawl entirely: `<host>/.devboard/`, `<host>/.worktree/`, `<host>/.git/`
   internals, every path under `<host>/.omp/`, package manager and tool caches, virtual
   environments, build and coverage outputs, and every ignored path. Do not cite an excluded path
   as evidence.
5. Do not open files that plainly hold secrets, such as environment value files, keystores, or
   credential stores.
6. When present, you may read the published `<host>/.omp/discover/sheet.json` and
   `<host>/.omp/discover/glossary/` as optional reference for the declared commands and the
   canonical terms. Nothing in this turn depends on them: when they are absent, work from the host
   itself.

Never block on an ambiguity and never ask a question. When the evidence is absent or insufficient,
state the rule the host plainly follows and omit the rest. Never invent a command, a dependency, a
path, or a convention.

## `SKILL.md`

Frontmatter, in this shape:

```yaml
---
name: discover-coding-conventions
description: One sentence naming the project-specific coding policy and when to apply it.
metadata:
  devboard-managed: "true"
  devboard-family: "discover"
  devboard-skill: coding-conventions
---
```

- `name` is exactly `discover-coding-conventions`; `description` is non-empty and at most 1024
  characters. Neither marker may be omitted; `devboard-managed` is the quoted string `"true"`.
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
  `<host>/.omp/discover/skills/discover-coding-conventions/SKILL.md`, read it for continuity of
  scope and structure and regenerate from the current crawl.

Content the skill must carry:

- The observed patterns of the codebase, in this project's own terms.
- Error handling: where a recoverable error is handled, what is never swallowed, and what a caller
  may assume.
- Typing: where a boundary must stay explicit, and the checks the project runs.
- Async style, logging, and the use the project makes of its declared dependencies.
- The exact lint, format, typecheck, and test commands the project declares.
- The constructs the project prohibits or avoids.
- Never recommend an invalidated or rejected term from the published glossary. When a skill
  describes a rule about a domain term, that term must appear in the glossary with its score; a
  rule about generic vocabulary the glossary omits names no concept.

## Determinism

Two crawls of the same unchanged host MUST produce the same skill apart from bounded prose. Use the
same headings, the same order, and the same exact commands; sort any list by its stable identity
key. Write no timestamp, run id, fingerprint, or machine-specific value.

## Before you stop

Confirm all of the following:

- [ ] `<staging-dir>/skills/discover-coding-conventions/SKILL.md` exists and is the only file
      staged.
- [ ] The frontmatter carries the exact name, a non-empty description of at most 1024 characters,
      and both markers with `devboard-family` set to `discover`.
- [ ] The body is one `#` heading plus imperative `- ` bullets; no bullet names a source, test,
      manifest, or CI path or cites where a rule was observed.
- [ ] Every exact command quoted in the skill appears verbatim in the crawled host.
- [ ] No concept named by the skill is absent from the published glossary, and no invalidated
      label is recommended.
- [ ] Nothing was written outside `<staging-dir>`; `GOAL.md`, `adrs/`, host source, `.omp/discover`,
      and `.omp/skills` are untouched.
- [ ] No question was asked and no project command, test, build, install, fetch, or forge query was
      run.

Reply with nothing. The staged file is the result.
