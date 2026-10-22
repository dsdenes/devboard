## Objective

Make the Devboard project a self-contained harness. The browser interface, Bun server, Svelte client, tests, fixtures, build configuration, container definition, and app documentation live under `.devboard/`. The repository root keeps only `AGENTS.md`, the host data (`adrs/` and `GOAL.md`), the installed `.omp/` wrappers, and `.gitignore`. Copying `.devboard/` into another project and running its install script sets up that project's `.omp/` wrappers. The harness stays project-agnostic: the lifecycle prompts continue to treat the host root, `adrs/`, and `GOAL.md` as the host, and never the interface under `.devboard/`.

## Success criteria

- After the merge, the repository root contains exactly `AGENTS.md`, `.gitignore`, `.omp/`, `adrs/`,
  `GOAL.md`, and `.devboard/`, plus `.git/` and the ignored `.worktree/`. No `client/`, `server/`,
  `package.json`, `bun.lock`, `vite.config.ts`, `svelte.config.js`, `tsconfig.json`, `index.html`,
  `Dockerfile`, `.dockerignore`, `README.md`, `node_modules/`, or `dist/` remains at the root.
- `.devboard/` contains `client/` (`App.svelte`, `app.css`, `main.ts`), `server/` (every source,
  test, and fixture file including `server/fixtures/stub-agent.ts`), `package.json`, `bun.lock`,
  `vite.config.ts`, `svelte.config.js`, `tsconfig.json`, `index.html`, `Dockerfile`,
  `.dockerignore`, `README.md`, executable `install.sh`, `omp/commands/adr-resolve.md`,
  `omp/commands/epic-next.md`, `omp/commands/goal-outcome.md`,
  `omp/extensions/implement-next-epic.ts`, and the existing `prompts/`, `extensions/`, `goals/`,
  and `tests/` directories.
- Root `.omp/` is byte-identical to `.devboard/omp/`.
- The moved `server/**`, `client/**`, `package.json`, `bun.lock`, `tsconfig.json`,
  `vite.config.ts`, `svelte.config.js`, `index.html`, `Dockerfile`, and `.dockerignore` files are
  byte-identical to their pre-move versions. The move changes no browser, server, transport, or
  container behavior.
- `cd .devboard && bun install --frozen-lockfile` exits 0.
- `cd .devboard && bun test` exits 0 with zero failures. It discovers all six `server/*.test.ts`
  files under `.devboard/` and every `.devboard/tests/*.test.ts` file, including a new
  install-script test. No test is skipped or marked only.
- `cd .devboard && bun run build` exits 0 and writes `.devboard/dist/index.html`.
- Starting the server from `.devboard` with `ADRS_DIR` pointing at the root `adrs/` and
  `GOAL_FILE` at the root `GOAL.md` serves `/` with HTTP 200. A WebSocket client receives 12
  records from `listRecords` and goal text equal to the root `GOAL.md` from `getGoal`.
- `docker build -t devboard-adr-ui:move-check .devboard` exits 0. The image runs with the root
  mounted at `/repo`, serves `/` with HTTP 200, and returns the same 12 records over `/ws`.
- `.devboard/install.sh [--force] [host-path]` copies every file under `.devboard/omp/` to the
  same relative path under `<host>/.omp/`. It is idempotent, leaves unrelated files in
  `<host>/.omp/` alone, refuses a target without `<host>/.devboard/`, refuses to overwrite a
  differing file without `--force`, overwrites with `--force`, and defaults to the
  `git rev-parse --show-toplevel` of the working directory when no path is given.
- A test at `.devboard/tests/install.test.ts` covers the success, idempotent-rerun,
  missing-`.devboard`, conflict-without-`--force`, and `--force` cases, and passes in
  `bun test`.
- The install script and every file under `.devboard/omp/` contain no absolute host path,
  repository name, remote, or host-specific value. The target host is an argument or is
  discovered at runtime.
- `AGENTS.md` describes the two-layer layout without weakening its existing rules:
  `.devboard/` owns the interface, its build/test/run commands, `omp/`, and `install.sh`;
  `adrs/` and `GOAL.md` are host data at the root; `.devboard/omp/` is canonical and
  `.devboard/install.sh` installs it into `<host>/.omp/`; the lifecycle prompts exclude
  `.devboard/`; the harness may define its own toolchain but must not assume host facts; deleting
  `.devboard/` must not break the host's own build, tests, or run paths.
- `.devboard/README.md` documents `cd .devboard` install/test/build/run, the `ADRS_DIR`,
  `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`, and `AGENT_COMMAND` variables, building the container
  from the `.devboard` context, and the install script. The root has no `README.md`.
- `.devboard/goals/integrate-adrkit-into-devboard.md` has every path and command reference
  updated to the new layout, including `.devboard/server/records.ts`, `.devboard/server/app.ts`,
  `.devboard/server/acp.ts`, `.devboard/client/App.svelte`, `.devboard/package.json`,
  `.devboard/Dockerfile`, `.devboard/README.md`, `.devboard/omp/mcp.json`,
  `cd .devboard && bun ...`, and `docker build ... .devboard`. `adrs/` and
  `.github/workflows/adr.yml` remain root-relative, and non-path statements are unchanged.
- Root `.gitignore` contains `node_modules/`, `dist/`, and `.worktree/`. `git check-ignore`
  reports `.devboard/node_modules`, `.devboard/dist`, and `.worktree` as ignored.
- The branch `devboard/move-project-into-devboard` is merged into `main`, its worktree is
  removed, and the branch is deleted.

## Verification

Run from the repository root with `main` checked out after the merge. Before making changes,
record the pre-move commit with `BASE=$(git rev-parse main)` and record the goal checksum with
`sha256sum GOAL.md >/tmp/devboard-goal.sha`.

Root layout:

```bash
test ! -e node_modules && test ! -e dist
test ! -e client && test ! -e server && test ! -e package.json && test ! -e bun.lock
test ! -e vite.config.ts && test ! -e svelte.config.js && test ! -e tsconfig.json
test ! -e index.html && test ! -e Dockerfile && test ! -e .dockerignore && test ! -e README.md
find . -maxdepth 1 -mindepth 1 -printf '%f\n' | grep -v -E '^(\.git|\.worktree)$' | sort
```

The final command prints exactly:

```text
.devboard
.gitignore
.omp
AGENTS.md
GOAL.md
adrs
```

Moved paths:

```bash
for p in \
  client/App.svelte client/app.css client/main.ts \
  server/acp.ts server/app.ts server/app.test.ts server/goal.ts server/goal-revision.test.ts \
  server/index.ts server/lifecycle-pause.test.ts server/lifecycle.test.ts server/records.ts \
  server/records.test.ts server/run.test.ts server/tracker.ts \
  server/fixtures/stub-agent.ts \
  package.json bun.lock vite.config.ts svelte.config.js tsconfig.json index.html Dockerfile \
  .dockerignore README.md install.sh omp prompts extensions goals tests; do
  test -e ".devboard/$p" || { echo "missing .devboard/$p"; exit 1; }
done
test -x .devboard/install.sh
diff -r .omp .devboard/omp
```

Byte-identical move and untouched harness files:

```bash
for f in \
  server/acp.ts server/app.ts server/app.test.ts server/goal.ts server/goal-revision.test.ts \
  server/index.ts server/lifecycle-pause.test.ts server/lifecycle.test.ts server/records.ts \
  server/records.test.ts server/run.test.ts server/tracker.ts server/fixtures/stub-agent.ts \
  client/App.svelte client/app.css client/main.ts \
  package.json bun.lock tsconfig.json vite.config.ts svelte.config.js index.html Dockerfile \
  .dockerignore; do
  git show "$BASE:$f" | cmp - ".devboard/$f" || { echo "changed: $f"; exit 1; }
done
for f in \
  .devboard/prompts/adr-resolve.md .devboard/prompts/epic-next.md \
  .devboard/prompts/goal-outcome.md .devboard/extensions/implement-next-epic.ts \
  .devboard/tests/implement-next-epic.test.ts \
  .omp/commands/adr-resolve.md .omp/commands/epic-next.md .omp/commands/goal-outcome.md \
  .omp/extensions/implement-next-epic.ts; do
  git show "$BASE:$f" | cmp - "$f" || { echo "changed: $f"; exit 1; }
done
git diff --quiet "$BASE" main -- adrs
sha256sum -c /tmp/devboard-goal.sha
```

Install, test, build:

```bash
( cd .devboard && bun install --frozen-lockfile )
( cd .devboard && bun test )
( cd .devboard && bun run build )
test -f .devboard/dist/index.html
```

Local interface smoke:

```bash
cat >/tmp/devboard-ws-smoke.ts <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";

const port = process.env.WS_PORT!;
const root = process.env.HOST_ROOT!;
const expectedGoal = readFileSync(join(root, "GOAL.md"), "utf8");
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let records: any = null;
let goal: string | null = null;
const timer = setTimeout(() => { console.error("timeout"); process.exit(1); }, 5000);
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "listRecords" }));
  ws.send(JSON.stringify({ type: "getGoal" }));
};
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === "records") records = message;
  if (message.type === "goal") goal = message.text;
  if (records && goal !== null) {
    clearTimeout(timer);
    const ok = records.records.length === 12 && goal === expectedGoal;
    console.log(ok ? "ws smoke ok" : "ws smoke failed");
    process.exit(ok ? 0 : 1);
  }
};
ws.onerror = () => { console.error("ws error"); process.exit(1); };
EOF

( cd .devboard && exec env PORT=18081 \
  ADRS_DIR="$PWD/../adrs" GOAL_FILE="$PWD/../GOAL.md" bun run start ) \
  >/tmp/devboard-move-ui.log 2>&1 &
UI_PID=$!
for i in $(seq 1 50); do
  curl -fsS -o /dev/null http://127.0.0.1:18081/ && break
  sleep 0.2
done
WS_PORT=18081 HOST_ROOT="$PWD" bun /tmp/devboard-ws-smoke.ts
kill "$UI_PID"
wait "$UI_PID" 2>/dev/null || true
```

Container smoke:

```bash
docker build -t devboard-adr-ui:move-check .devboard
docker run --rm -d --name devboard-adr-ui-move-check \
  -p 127.0.0.1:18082:8080 -v "$PWD:/repo" devboard-adr-ui:move-check
for i in $(seq 1 50); do
  curl -fsS -o /dev/null http://127.0.0.1:18082/ && break
  sleep 0.2
done
WS_PORT=18082 HOST_ROOT="$PWD" bun /tmp/devboard-ws-smoke.ts
docker rm -f devboard-adr-ui-move-check
docker image rm devboard-adr-ui:move-check
```

Install-script smoke:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/host"
cp -R .devboard "$tmp/host/.devboard"
git init -q "$tmp/host"
( cd .devboard && ./install.sh "$tmp/host" )
diff -r .devboard/omp "$tmp/host/.omp"
touch "$tmp/host/.omp/unrelated.txt"
( cd .devboard && ./install.sh "$tmp/host" )
mkdir -p "$tmp/bare"
if ( cd .devboard && ./install.sh "$tmp/bare" ); then
  echo "missing .devboard was accepted"; exit 1
fi
test ! -e "$tmp/bare/.omp"
printf 'different\n' > "$tmp/host/.omp/commands/adr-resolve.md"
if ( cd .devboard && ./install.sh "$tmp/host" ); then
  echo "conflict was accepted"; exit 1
fi
grep -qx 'different' "$tmp/host/.omp/commands/adr-resolve.md"
( cd .devboard && ./install.sh --force "$tmp/host" )
diff -r .devboard/omp "$tmp/host/.omp"
test -e "$tmp/host/.omp/unrelated.txt"
( cd "$tmp/host/.devboard" && ./install.sh )
diff -r "$tmp/host/.devboard/omp" "$tmp/host/.omp"
rm -rf "$tmp"
```

`AGENTS.md`, `README.md`, and the pending goal:

```bash
grep -F '## Harness rules' AGENTS.md
grep -F 'Containment' AGENTS.md
grep -F 'Portability' AGENTS.md
grep -F 'Host-neutral deletion' AGENTS.md
grep -F '.devboard/omp' AGENTS.md
grep -F 'install.sh' AGENTS.md
grep -F 'adrs/' AGENTS.md
grep -F 'GOAL.md' AGENTS.md
test ! -e README.md
grep -F 'cd .devboard' .devboard/README.md
grep -F 'bun install' .devboard/README.md
grep -F 'bun test' .devboard/README.md
grep -F 'bun run build' .devboard/README.md
grep -F 'ADRS_DIR' .devboard/README.md
grep -F 'docker build' .devboard/README.md
grep -F 'install.sh' .devboard/README.md

G=.devboard/goals/integrate-adrkit-into-devboard.md
for p in \
  .devboard/server/records.ts .devboard/server/app.ts .devboard/server/acp.ts \
  .devboard/client/App.svelte .devboard/package.json .devboard/Dockerfile \
  .devboard/README.md .devboard/omp/mcp.json; do
  grep -F "$p" "$G" || { echo "missing $p in $G"; exit 1; }
done
grep -F 'cd .devboard && bun run adr:lint' "$G"
grep -F -- '--dir ../adrs' "$G"
grep -F '.github/workflows/adr.yml' "$G"
! grep -F '.devboard/.github/' "$G"
! grep -F '`server/records.ts`' "$G"
! grep -F '`server/app.ts`' "$G"
! grep -F '`server/acp.ts`' "$G"
! grep -F '`client/App.svelte`' "$G"
! grep -F '`package.json`' "$G"
! grep -F '`Dockerfile`' "$G"
! grep -F '`README.md`' "$G"
grep -F 'ten existing records' "$G"
grep -F 'Do not create an ADR-0011' "$G"
diff -u /tmp/adrkit-goal-before.md "$G"
```

Inspect the final diff: every changed line differs only in a path or command reference.

Ignore rules and cleanup:

```bash
grep -qx 'node_modules/' .gitignore
grep -qx 'dist/' .gitignore
grep -qx '.worktree/' .gitignore
for p in .worktree .devboard/node_modules .devboard/dist; do
  git check-ignore -q "$p" || { echo "not ignored: $p"; exit 1; }
done
! git worktree list --porcelain | grep -F '.worktree/move-project-into-devboard'
! git branch --list devboard/move-project-into-devboard | grep -q .
```

## Boundaries

Allowed in the worktree `.worktree/move-project-into-devboard/` on branch
`devboard/move-project-into-devboard`: move the tracked app files, tests, fixtures, manifests,
configs, Dockerfile, and app documentation into `.devboard/`; add `.devboard/omp/`,
`.devboard/install.sh`, and `.devboard/tests/install.test.ts`; edit `.devboard/README.md`, the
root `AGENTS.md`, and the root `.gitignore`; sync the root `.omp/` with `.devboard/omp/`; remove
the root `node_modules/` and `dist/`. The moved app source, tests, manifests, Dockerfile, and
build configs move byte-identically.

Allowed only after the merge, in the opened checkout: remove the stale root `node_modules/` and
`dist/`, and rewrite the path and command references in the untracked
`.devboard/goals/integrate-adrkit-into-devboard.md`. No tracked file in the opened checkout is
edited.

Untouched: `adrs/` (all 12 files and their contents), `GOAL.md`,
`.devboard/prompts/adr-resolve.md`, `.devboard/prompts/epic-next.md`,
`.devboard/prompts/goal-outcome.md`, their exclusion of `.devboard/`,
`.devboard/extensions/implement-next-epic.ts`, `.devboard/tests/implement-next-epic.test.ts`,
the four `.omp/` files' content, `server/` and `client/` logic, the WebSocket contract,
`package.json` dependencies and scripts, `bun.lock`, `tsconfig.json`, `vite.config.ts`,
`svelte.config.js`, `index.html`, `Dockerfile`, `.dockerignore`, `.git`, and
`.worktree/show-edit-and-save-the-current` with its branch.

Do not add a root `README.md`; do not commit `GOAL.md`, `.worktree/`, or the new goal file; do not
add dependencies or fetch new ones; do not change the lifecycle's target from the host root to
`.devboard/`; do not rewrite the non-path statements of the adrkit goal, including its
record-count and ADR-numbering statements.

Merge the branch into `main` directly, then remove the worktree and delete the branch. Never
force-push, rewrite history, or run destructive git commands. Wrap every repository text line at
768 bytes or less, aiming for 100 columns. Keep the harness host-agnostic: no absolute paths,
repository names, remotes, secrets, or host stack assumptions under `.devboard/`; the install
script takes the host path as an argument or discovers it at runtime.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is
verified against the current state.

Halt and surface only for genuine ambiguity that this goal and the repository cannot resolve, a
risky or irreversible operation, a missing prerequisite, or a blocked external dependency.
Examples: `bun install --frozen-lockfile` fails under `.devboard/`; the build or test suite fails
for a reason outside the move; Docker cannot build or run the image; the install script cannot
stay idempotent without overwriting unrelated files; merging the branch conflicts with `main` in
a way that requires a human decision; the existing worktree `.worktree/show-edit-and-save-the-current`
blocks creation of the new worktree; the interface smoke cannot read the root `GOAL.md` or
`adrs/`. Do not halt for effort, question count, or the number of fix-and-rerun cycles.
