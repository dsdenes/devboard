## Objective

The msgpack library that currently shares the `dsdenes/devboard` checkout lives in its own public
GitHub repository, `dsdenes/msgpack`, checked out at `/home/ds/msgpack`, while `dsdenes/devboard`
holds the devboard harness and nothing of the msgpack project. The msgpack repository tracks the
library, tests, benchmarks, examples, verification scripts, workspace manifests, README, CHANGELOG
and `GOAL.md`; harness directories, installed agent wrappers and the host contract file stay on disk
but untracked, reached through links to the devboard checkout. Every build, test, typecheck and
verification command that runs today from the shared checkout runs from `/home/ds/msgpack` with the
same result, the package metadata names `dsdenes/msgpack` instead of the harness repository, and no
new release is published. The devboard checkout keeps only the harness plus its own interface
decision records.

## Success criteria

**New repository**

- `dsdenes/msgpack` exists on GitHub with visibility `PUBLIC` and default branch `main`.
- `/home/ds/msgpack` is a git work tree whose `origin` is `https://github.com/dsdenes/msgpack.git`;
  its `HEAD` equals the remote `main` (`git ls-remote`), with at least one commit and a clean
  `git status --porcelain`.
- Its tracked file list contains `package.json`, `bun.lock`, `tsconfig.json`, `README.md`,
  `CHANGELOG.md`, `GOAL.md`, `packages/msgpack/package.json`, `packages/msgpack/src/index.ts`,
  `packages/msgpack/lib/index.mjs`, `scripts/build.ts`, `test/compat.test.ts`, `bench/bench.ts`,
  `verification/server-adoption.ts` and `examples/browser/index.html`.
- Its tracked file list contains no path under `.devboard/`, `.omp/`, `adrs/` and no `AGENTS.md`,
  `WATCHDOG.yml` or `node_modules` entry.
- `AGENTS.md`, `.devboard`, `.omp/commands`, `.omp/extensions`, `.omp/skills` and `.omp/config.yml`
  are ignored, and each is present on disk (`AGENTS.md` as a file, the rest reachable).
- `cd /home/ds/msgpack && bun install` exits 0.
- `cd /home/ds/msgpack && bun run build` exits 0 and rewrites `packages/msgpack/lib/index.mjs`,
  `index.cjs`, `index.d.ts` and `msgpack.js`.
- `cd /home/ds/msgpack && bun test` exits 0 with the full test suite (same test files as the
  pre-migration checkout).
- `cd /home/ds/msgpack && bun run typecheck` exits 0.
- `cd /home/ds/msgpack && bun run verify:surface` exits 0, and `npm pack --dry-run` inside
  `packages/msgpack` lists exactly `package.json`, `README.md`, `LICENSE` and files under `lib/`.
- `packages/msgpack/package.json` declares `repository.url` `git+https://github.com/dsdenes/msgpack.git`,
  `repository.directory` `packages/msgpack`, `homepage`
  `https://github.com/dsdenes/msgpack/tree/main/packages/msgpack#readme` and `bugs.url`
  `https://github.com/dsdenes/msgpack/issues`; the root workspace `package.json` name contains no
  `devboard`.
- No tracked file outside `CHANGELOG.md` contains `dsdenes/devboard`; `CHANGELOG.md` keeps only its
  historical entries.

**Devboard repository**

- `dsdenes/devboard` remains `PRIVATE`, and `/home/ds/devboard` is clean against its remote `main`
  with the cleanup commit pushed.
- Its tracked file list is confined to `AGENTS.md`, `.gitignore`, `.devboard/**`, `.omp/**` and
  `adrs/**`; no `packages/`, `examples/`, `test/`, `bench/`, `verification/`, `scripts/`,
  `node_modules/`, root `package.json`, `bun.lock`, `tsconfig.json`, root `README.md`,
  `CHANGELOG.md` or `GOAL.md` is tracked.
- `adrs/` is restored: the 12 records `0001-interface-runtime-and-language.md` through
  `0012-lifecycle-pause-and-resume-control.md` are tracked files again.
- No tracked or staged file shows as deleted or modified in `git status --porcelain` (untracked
  harness artifacts are allowed).
- `cd /home/ds/devboard/.devboard && bun test` exits 0 and `bun run build` exits 0.

**Shared state**

- `/home/ds/msgpack/.devboard`, `/home/ds/msgpack/.omp/commands` and `/home/ds/msgpack/.omp/extensions`
  are symlinks resolving to their `/home/ds/devboard` counterparts.
- `/home/ds/devboard/.worktree/decode-consecutive-messages-from-one-buffer` still holds its 13
  modified files and `verification/multi-decode.ts`, unchanged; both worktrees still open.
- The npm registry still serves `@dsdenes/msgpack@1.0.0`; no new version, tag or publish exists.

## Verification

Run each command against the current state; every one must exit 0 or produce the stated output.

```sh
gh repo view dsdenes/msgpack --json visibility,defaultBranchRef
gh repo view dsdenes/devboard --json visibility,defaultBranchRef
git -C /home/ds/msgpack remote -v
git -C /home/ds/msgpack status --porcelain --branch
git -C /home/ds/msgpack rev-parse HEAD
git ls-remote https://github.com/dsdenes/msgpack.git refs/heads/main
git -C /home/ds/msgpack ls-files
git -C /home/ds/msgpack ls-files | grep -E '^(\.devboard/|\.omp/|adrs/|AGENTS\.md$|WATCHDOG\.yml$)'   # exits 1
for p in AGENTS.md .devboard .omp/commands .omp/extensions .omp/skills .omp/config.yml; do
  git -C /home/ds/msgpack check-ignore --quiet "$p" || exit 1
done
readlink -f /home/ds/msgpack/.devboard /home/ds/msgpack/.omp/commands /home/ds/msgpack/.omp/extensions
cd /home/ds/msgpack && bun install && bun run build && bun test && bun run typecheck
cd /home/ds/msgpack && bun run verify:surface
cd /home/ds/msgpack/packages/msgpack && npm pack --dry-run --json
cd /home/ds/msgpack && bun -e 'const p = require("./package.json"); process.exit(/devboard/.test(p.name) ? 1 : 0)'
cd /home/ds/msgpack && git grep -l 'dsdenes/devboard' -- . ':!CHANGELOG.md'   # exits 1
git -C /home/ds/devboard status --porcelain --branch
git -C /home/ds/devboard ls-files
git -C /home/ds/devboard ls-files | grep -vE '^(AGENTS\.md|\.gitignore|\.devboard/|\.omp/|adrs/)'  # exits 1
git -C /home/ds/devboard ls-files adrs | wc -l                                                # 12
git -C /home/ds/devboard status --porcelain | grep -E '^(M| D|D |A |R )'                     # exits 1
cd /home/ds/devboard/.devboard && bun test && bun run build
git -C /home/ds/devboard/.worktree/decode-consecutive-messages-from-one-buffer status --porcelain
git -C /home/ds/devboard/.worktree/show-edit-and-save-the-current status --porcelain          # empty
npm view @dsdenes/msgpack version                                                              # 1.0.0
```

## Boundaries

Allowed writes:

- `/home/ds/msgpack`: create the checkout, copy the host files, add the harness-ignoring
  `.gitignore`, wire `.devboard`/`.omp` links and the ignored `AGENTS.md`, rewrite only the
  `repository`, `homepage`, `bugs` and `name` fields noted above, commit, and push `main`.
- `/home/ds/devboard`: delete the host files and their build artifacts, restore `adrs/`, adjust the
  root `.gitignore` to the harness tree, commit, and push `main`.
- `dsdenes/msgpack` on GitHub: create the public repository and receive the initial push.
- Nothing else: no `npm publish`, no version bump, no tags, no force push, no history rewrite in
  either repository, no branch deletion.

Untouched:

- `.worktree/` and both worktrees, including every uncommitted host change inside them.
- `/home/ds/devboard/.devboard/**` harness source except for the goal file already written, and
  `/home/ds/devboard/.omp/**`; installed wrappers are not regenerated or hand-edited.
- `/home/ds/devboard2` and its symlinks.
- The library sources under `packages/msgpack/src/`, `test/`, `bench/`, `verification/`,
  `examples/`, `scripts/` and the README/CHANGELOG content: they move byte-identical.
- The published `@dsdenes/msgpack@1.0.0` registry entry and the local `.env`.
- `WATCHDOG.yml`: it stays a local, untracked file; it is neither committed nor moved into the
  msgpack repository.

All other work stays inside `/home/ds/devboard` and `/home/ds/msgpack`; the creation of
`/home/ds/msgpack` itself is the one authorized write outside the current repository root.

## Stop conditions

No attempt cap, token budget, time limit or retry ceiling: continue until every criterion above is
verified, then stop.

Halt and surface instead of improvising only for:

- an answer the repository cannot supply (what belongs to the project versus the harness beyond the
  paths listed here);
- a risky or irreversible step not authorized by the boundaries: rewriting either repository's
  history, force pushing, deleting a worktree or branch, or publishing to npm;
- a missing prerequisite: `gh` unauthenticated, no permission to create `dsdenes/msgpack`, no
  network for `bun install`/`npm pack`;
- an external dependency blocking verification.
