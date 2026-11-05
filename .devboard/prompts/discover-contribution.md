---
description: Crawl the host and its merged pull-request history read-only and stage the contribution sheet and skill.
---

## Manifesto

Your goal is to record how this host wants a change contributed, and the observable result is the
run's staged contribution sheet and contribution skill written through the Devboard MCP staging
tools and then published by the server.

## Contract

- `<host>` is the git top level: `git rev-parse --show-toplevel`. If that fails, use the current
  working directory.
- `<staging-dir>` is the run's staging directory, passed to every staging tool call. The tools are
  the only writers; never create or edit a staged file by hand.
- The server owns publication and derives the profile. Never write outside `<staging-dir>`, and
  never touch `<host>/.omp/discover/`, `<host>/.omp/skills/`, `<host>/GOAL.md`, anything under
  `<host>/adrs/`, or any host source file.
- Never write `manifest.json` or `decisions.json`; the server generates both.
- This is a read-only crawl. Read files and use only these safe read-only git facts:
  `git rev-parse`, `git log`, `git branch`, `git status`, `git ls-files`, and
  `git remote get-url`. Run no project command, test, build, package-manager step, install,
  formatter, code generator, or any write. The only network traffic in this turn is the model
  endpoint that serves this session and the read-only forge requests described below.
- Never write to the forge. Never create, comment, label, approve, merge, close, or edit anything
  there. Never copy a token, credential, password, private key, secret, private URL, or URL
  containing user info into any staged file.
- If `<staging-dir>` is missing, empty, unwritable, or outside `<host>/.omp/discover/staging/`,
  reply exactly `halt: staging directory is not usable` and stop. Otherwise write no status line.

## Crawl

Read only what you need, so the contribution sheet states what this host actually does.

1. Inventory the git top level with `git ls-files` and `git status`.
2. Read the contribution entry points: a contribution guide, issue templates, pull-request
   templates, a code of conduct, support or discussion pointers, and the documentation index.
3. Read manifests, task-runner files, CI configuration, test configuration, and test directories
   to find the exact install, build, lint, typecheck, run, and whole-suite test commands and the
   test levels the repository declares.
4. Read commit subjects and bodies from `git log --no-merges` and branch names from
   `git branch --all` for the conventions the repository follows.
5. Exclude from the crawl entirely: `<host>/.devboard/`, `<host>/.worktree/`, `<host>/.git/`
   internals, every path under `<host>/.omp/`, package manager and tool caches, virtual
   environments, build and coverage outputs, and every ignored path. Do not cite an excluded path
   as evidence.
6. Do not open files that plainly hold secrets, such as environment value files, keystores, or
   credential stores.
7. Never read `<host>/.omp/discover/contribution.json` or any other published Discover artifact to
   fill a fact. This run works from the host and the forge only.

## Merge history

Read the merge history through the repository's one forge-auth resolution, read-only.

1. Resolve the origin remote with `git remote get-url origin` and record its forge host. The forge
   is `github`, `gitlab`, or `gitea`.
2. Select an identity with `<devboard> forge-auth check --forge <name> --required
   read` when the harness ships that command, where `<devboard>` is the absolute harness binary
   resolved once per session as `.devboard/prompts/forge-auth.md` states. For GitHub use `gh`
   through the same `<devboard> forge-auth exec -- gh ...`; for GitLab use `glab` through
   `<devboard> forge-auth exec -- glab ...`; for Gitea query
   `$DEVBOARD_GITEA_URL/api/v1/repos/<owner>/<repo>/...` with the token the check
   selected. Every request is a read (`GET`).
3. A pull request is **merged** only when the forge records it as merged: `merged_at` is set for
   GitHub and Gitea, or `state` is `merged` for GitLab. A pull request the forge records as closed
   without a merge is **closed-unmerged** and is counted separately. It is never an exemplar and
   never contributes to a statistic.
4. Take at most the 50 most recently merged pull requests, newest merge first, breaking ties by
   descending number. For each, record its number, title, body, merged time, additions,
   deletions, changed-file count, the changed file paths, test-file count, documentation-file
   count, labels, draft flag, approval count, required check names, commit subjects and bodies,
   head branch, the forge's merge method for the change (`merge`, `squash`, or `rebase`), and the
   issue numbers its title or body references.
5. Count the closed-unmerged pull requests you can see and record only their numbers. Never record
   their titles, bodies, authors, or any other description text.
6. When the target has no forge credential, no reachable forge, or no origin remote, do not halt:
   stage `null` for `forge` and `host`, `null` for `window`, an empty merged list, an empty
   closed-unmerged list, and a one-line `unavailable` reason. The workflow and testing facts still
   publish from the git crawl.

## Staging

Call `discover_contribution_stage` once with `stagingDir` set to `<staging-dir>` and
`contribution` set to the complete object below. Then call `discover_skill_stage` once with `name`
set to `discover-contribution`, its one-line description, and its heading-plus-bullets body. The
tools write the run's staged artifacts; write no other file, note, log, or temporary file. Order
every object key, array, and enum exactly as specified.

## Contribution sheet

Top-level key order: `schemaVersion`, `source`, `workflow`, `testing`.

```json
{
  "schemaVersion": 1,
  "source": {
    "forge": "gitea",
    "host": "gitea.example",
    "unavailable": null,
    "window": { "from": "2026-01-01T00:00:00Z", "to": "2026-06-01T00:00:00Z" },
    "mergedPullRequests": [],
    "closedUnmergedPullRequests": [7, 11]
  },
  "workflow": [],
  "testing": []
}
```

- `schemaVersion` is exactly `1`.
- `source.forge` is `github`, `gitlab`, `gitea`, or `null`. `source.host` is the origin host or
  `null`. `source.unavailable` is `null` or one reason line.
- `source.window` is `{ "from", "to" }` with ISO timestamps, or `null` when no merged sample
  exists. `from` is the earliest merged time, `to` the latest.
- `source.mergedPullRequests` is the merged sample, newest merge first. Its records carry, in this
  key order: `number`, `title`, `body`, `mergedAt`, `additions`, `deletions`, `filesChanged`,
  `files`, `testFiles`, `documentationFiles`, `labels`, `draft`, `approvals`, `checks`, `commits`,
  `branch`, `mergeMethod`, `references`.
- `files` is the sorted, deduplicated list of repository-relative changed paths and its length
  equals `filesChanged`. `testFiles` counts the `files` that are tests. `documentationFiles`
  counts the `files` that are documentation, a changelog, or release notes. A count never exceeds
  `filesChanged`.
- `commits` is a list of `{ "subject", "body" }`; `body` is `""` when the commit has none.
- `references` is the sorted list of issue numbers the pull request links or closes.
- `source.closedUnmergedPullRequests` is the sorted list of closed-unmerged numbers. A record
  carries no other key.
- No number may appear in both lists.
- When `source.unavailable` is not `null`, `forge` and `host` are `null`, both pull-request lists
  are empty, and `window` is `null`.

Each `workflow` and `testing` entry is one fact:

```json
{
  "key": "install",
  "value": "bun install",
  "evidence": ["package.json"],
  "confidence": "declared"
}
```

- `key` is one of the keys listed below and appears at most once per section.
- A known fact carries `value`, at least one `evidence` entry, and `confidence` set to
  `observed`, `declared`, or `inferred`.
- An unknown fact carries no `value` key at all, an empty `evidence` list, `confidence` set to
  `unknown`, and a one-line `reason` no longer than 200 characters.
- `evidence` is a repository-relative path, `PR #<number>`, `commit <sha>`, `git log`,
  `git status`, `git branch`, `git ls-files`, or `forge records`. Never an absolute path, a URL,
  or a path under `.omp/`, `.devboard/`, `.worktree/`, or `.git/`.

`workflow` keys, in this order:

- `entryPoints`: list of the contribution entry points the repository provides, such as
  `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug.yml`, and `CODE_OF_CONDUCT.md`.
- `steps`: list of the contribution steps in order.
- `prerequisites`: list of the tools or accounts a contributor must set up first.
- `install`: the exact install command.
- `build`: the exact build command.
- `lint`: the exact lint command.
- `typecheck`: the exact typecheck command.
- `run`: the exact command that runs or tries out the project.

`testing` keys, in this order:

- `suite`: the exact command that runs the whole test suite.
- `levels`: list of `{ "level", "command", "paths", "fixtures" }` records for the test levels the
  repository declares. `level` is `unit`, `integration`, `contract`, `end-to-end`, or `other`;
  `paths` is a sorted list of representative test paths; `fixtures` is a sorted list of the paths
  that hold fixtures or helpers.

The server derives `pull-request-style`, `pull-request-size`, `conventions`, `review`,
`documentation`, `hotspots`, and `evidence` from `source`. Stage no derived fact.

## Contribution skill

Call `discover_skill_stage` with `name` set to `discover-contribution`, `description` set to one
sentence naming how a change should be proposed and described in this repository, and `body` set
to a `#` heading title followed only by imperative bullets and the exemplar quotes. The tool writes
the managed frontmatter.

The staged skill carries this frontmatter, written by the tool:

```yaml
---
name: discover-contribution
description: One sentence naming how a change should be proposed and described in this repository.
metadata:
  devboard-managed: "true"
  devboard-family: "discover"
  devboard-skill: contribution
---
```

- `name` is exactly `discover-contribution`; `description` is non-empty and at most 1024
  characters. `devboard-managed` is the quoted string `"true"`, `devboard-family` is `discover`,
  and `devboard-skill` is `contribution`.
- The body opens with one `#` heading and is otherwise imperative `- ` bullets. The only prose
  allowed is the quoted exemplar blocks described below.
- State the rules a future agent follows to author a pull request of this repository:
  - the target size range derived from the merged sample;
  - the required description structure and section order;
  - the tone, length, and vocabulary targets;
  - the exact commands to run and the test evidence to include;
  - issue linking, commit subject and branch conventions;
  - the review and CI gates an accepted change passes;
  - the documentation or changelog expectation.
- Name the published contribution artifact at `.omp/discover/contribution.json`.
- State no number, count, command, or rule that the crawled host and merged sample do not support.
  When the merged sample is empty or unavailable, say in a bullet that the pull-request-derived
  rules and exemplars are unknown, quote the one-line `unavailable` reason verbatim, and keep only
  the git-derived rules.

### Exemplars

End the body with a `## Exemplars` heading and one quoted block per exemplar, in this exact
shape:

```
## Exemplars
> PR #42 — fix(api): keep the empty order total at zero
> The first body line, exactly as the merged pull request recorded it.
> The second body line.
```

- Quote exactly the three most recently merged pull requests, newest merge first, breaking ties by
  descending number.
- The marker line is `> PR #<number> — <title>`, using an em dash. Every following `>` line is one
  body line; `>` alone is an empty body line. Quote the body with its leading and trailing
  whitespace trimmed.
- Copy the title and body verbatim. Never quote a closed-unmerged pull request and never invent an
  exemplar.
- When there are fewer than three merged pull requests, quote every one. When there are none,
  quote none and state the unknown in a bullet.

## Determinism

Two crawls of the same unchanged host and merge set MUST produce the same document and skill apart
from bounded prose. Use the same keys, the same order, the same commands, and the same exemplars;
sort every list by its stable identity key. Write no timestamp, run id, fingerprint, or
machine-specific value.

## Before you stop

Confirm all of the following:

- [ ] `discover_contribution_stage` and `discover_skill_stage` returned their staged paths and no
      other file was staged.
- [ ] Every known fact carries a value, evidence, and a confidence; every unknown fact carries a
      reason and no value.
- [ ] The merged list holds only pull requests the forge records as merged, and the closed list
      holds only numbers.
- [ ] The skill frontmatter carries the exact name, a non-empty description, and the three
      markers; the body is one `#` heading plus imperative bullets and the exemplar quotes.
- [ ] The exemplars are exactly the three most recently merged pull requests, copied verbatim.
- [ ] No token, credential, absolute path, or URL with user info appears in either file.
- [ ] Nothing was written outside `<staging-dir>`; `GOAL.md`, `adrs/`, host source, `.omp/discover`,
      `.omp/skills`, and the forge are untouched.

Reply with nothing. The staged files are the result.
