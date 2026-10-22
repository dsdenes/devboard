## Objective

This repository — the `devboard` host project at the repo root, together with the generic lifecycle prompts under `.devboard/` — adopts adrkit 0.20.0 as its decision-record system. The ten existing records in `adrs/` become adrkit-valid typed records with preserved bodies and backfilled metadata; the browser interface reads that corpus through `@adrkit/core` and treats both `draft` and `proposed` as pending; the lifecycle prompts create and update adrkit-shaped records generically; and the corpus is enforced locally, in GitHub Actions, and available to agents through the adrkit MCP server.

## Success criteria

- `adrs/` holds exactly the ten existing records 0001–0010. No new record is added.
- Every record starts with adrkit YAML frontmatter carrying at least `schemaVersion: 0.2.0`, `id`, `title`, `status: accepted`, `date: 2026-10-19`, `deciders` containing `@dsdenes`, and an `affects` list.
- The markdown body below each frontmatter is unchanged except that the legacy `- Status:` bullet is removed and record 0005's Context and Decision are amended.
- Record 0005's Context and Decision describe status as the frontmatter `status` field, state that both `draft` and `proposed` are pending, and keep the lowest-numbered pending file as next. Its status remains `accepted`; no record is superseded.
- `affects` is populated only for files a record directly governs. `adr explain` reports: 0005 for `.devboard/server/records.ts`; 0002, 0009, and 0010 for `.devboard/client/App.svelte`; 0001, 0007, and 0008 for `.devboard/Dockerfile`; 0004 for `.devboard/server/acp.ts`; 0001 for `.devboard/package.json`; and 0003, 0006, 0009, and 0010 for `.devboard/server/app.ts`. Records with no identifiable governed file keep `affects: []`.
- `.devboard/package.json` depends on `@adrkit/core@0.20.0` at runtime and dev-depends on `@adrkit/cli@0.20.0` and `@adrkit/mcp@0.20.0`. Scripts `adr:lint`, `adr:graph`, and `adr:queue` pass `--dir ../adrs`.
- `.devboard/server/records.ts` reads the corpus through `@adrkit/core`'s `lintCorpus`. The `AdrRecord` contract remains `file`, `title`, `status`, `pending`. `pending` is true for `draft` or `proposed`; `status` is rendered with a capital first letter; records are ordered by file name; and `next` is the first pending file.
- The server, client, ACP prompt, test fixtures, and stub agent contain no legacy `- Status:` parsing or writing. Every test record is adrkit-valid.
- `cd .devboard && bun run adr:lint` exits 0 with `checked 10 records` and `0 errors`.
- `cd .devboard && bun test` exits 0 and `cd .devboard && bun run build` exits 0.
- `.github/workflows/adr.yml` runs `cd .devboard && bun run adr:lint` on pushes to `main` and on pull requests. On pull requests it also runs `mbeacom/adrkit@v0.20.0` with `dir: adrs` and `pull-requests: write`, posting the governing-decisions comment.
- `.devboard/omp/mcp.json` defines a stdio server named `adrkit` running `bunx @adrkit/mcp --cwd . --dir adrs`. The server answers `tools/list` with `search_decisions`, `get_decision`, `get_decision_context`, and `list_superseded`.
- `.devboard/prompts/adr-resolve.md` updates the status in existing YAML frontmatter, including `supersededBy`, when present, and otherwise uses the legacy status line, never creating both. `.devboard/prompts/epic-next.md` writes a new record in the corpus's existing frontmatter shape when records use frontmatter, and keeps the legacy shape otherwise. Neither prompt names adrkit, a host path, or a host-specific status spelling.
- `.devboard/README.md` documents the adrkit format, the `adr:*` scripts, the CI workflow, the MCP configuration, and that `draft` and `proposed` are pending.
- The Docker image still builds and starts with `@adrkit/core` available at runtime; the runtime stage installs production dependencies.

## Verification

Run from the repository root after the worktree is merged to `main`.

- `cd .devboard && bun install` exits 0 and updates `.devboard/bun.lock`.
- `cd .devboard && bun run adr:lint` exits 0 and reports `checked 10 records` with `0 errors`.
- `cd .devboard && bunx @adrkit/cli explain ../.devboard/server/records.ts --dir ../adrs` lists `0005`.
- `cd .devboard && bunx @adrkit/cli explain ../.devboard/client/App.svelte --dir ../adrs` lists `0002`, `0009`, and `0010`.
- `cd .devboard && bunx @adrkit/cli explain ../.devboard/Dockerfile --dir ../adrs` lists `0001`, `0007`, and `0008`.
- `cd .devboard && bunx @adrkit/cli explain ../.devboard/server/acp.ts --dir ../adrs` lists `0004`.
- `cd .devboard && bunx @adrkit/cli explain ../.devboard/package.json --dir ../adrs` lists `0001`.
- `cd .devboard && bunx @adrkit/cli explain ../.devboard/server/app.ts --dir ../adrs` lists `0003`, `0006`, `0009`, and `0010`.
- `cd .devboard && bunx @adrkit/cli graph --dir ../adrs --format json` exits 0 and emits ten nodes.
- `! grep -R "^- Status:" adrs` produces no output.
- `cd .devboard && bun test` exits 0.
- `cd .devboard && bun run build` exits 0.
- `bun -e 'import { parse } from "yaml"; import { readFileSync } from "node:fs"; parse(readFileSync(".github/workflows/adr.yml", "utf8")); parse(readFileSync(".devboard/omp/mcp.json", "utf8"))'` exits 0.
- Start the MCP server with `cd .devboard && { printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 2; } | timeout 30 bunx @adrkit/mcp --cwd "$PWD/.." --dir ../adrs`; the output lists all four tool names named in the success criteria.
- `docker build -t devboard-adr-ui:adrkit-check .devboard` exits 0; run it with `-p 127.0.0.1:18080:8080 -v "$PWD:/repo"`, request `http://127.0.0.1:18080/`, confirm a 200 response, then remove the container.
- Inspect the two harness prompts and confirm each contains an explicit frontmatter branch and a legacy fallback, with no adrkit name, host path, or host-specific status spelling.
- Inspect `.devboard/README.md` and confirm it names the format, `adr:lint`, the workflow, the MCP server, and `draft`/`proposed` pending behavior.

## Boundaries

Host scope — allowed files and directories: `adrs/`, `.devboard/server/`, `.devboard/client/` only where the status label must change, `.devboard/package.json`, `.devboard/bun.lock`, `.devboard/Dockerfile`, `.devboard/README.md`, `.github/workflows/adr.yml`, `.devboard/omp/mcp.json`, and their tests. Harness scope — allowed files: `.devboard/prompts/adr-resolve.md` and `.devboard/prompts/epic-next.md`. The goal file itself is `.devboard/goals/integrate-adrkit-into-devboard.md`.

All edits, builds, and test runs happen in an isolated git worktree at `.worktree/adrkit-integration/`. Merge that worktree directly into `main`, then delete the worktree and its branch. Do not edit the opened checkout. Do not add `.worktree/` to git.

Leave untouched: the corpus path (`adrs/`), the browser/server API and event contract, the lifecycle stages and control protocol, the goal editor, `.devboard/omp/commands/`, `.devboard/omp/extensions/`, `.devboard/extensions/`, `.devboard/tests/`, `.devboard/prompts/goal-spec.md`, `.devboard/prompts/goal-outcome.md`, `.devboard/agents` if present, `GOAL.md`, `AGENTS.md`, `.devboard/tsconfig.json`, `.devboard/vite.config.ts`, `.devboard/svelte.config.js`, `.devboard/index.html`, `.devboard/.dockerignore`, and `.gitignore`. Do not create an ADR-0011, do not supersede 0005, do not add a GitHub Pages portal, and do not add agent-plugin commands or skills.

The harness prompt changes must stay project-agnostic. They may describe YAML frontmatter and status fields generically, but must not name adrkit, this repository, its paths, or its status vocabulary as fixed values. Host-specific detail belongs only in host files.

Preserve the existing ten record filenames and numbering. Keep the migration one-way and body-preserving apart from the explicit 0005 amendment and the removed legacy status bullets. Do not run destructive git commands, force-push, or rewrite history.

## Stop conditions

There is no attempt cap and no token or time budget. Continue until every success criterion is verified against the current state.

Halt and surface only for genuine ambiguity that the repository and this goal cannot resolve, a risky or irreversible operation, a missing prerequisite, or a blocked external dependency. Examples: the npm registry cannot supply adrkit 0.20.0; `adr migrate` would overwrite a record unexpectedly; `cd .devboard && bun test` or `cd .devboard && bun run build` fails for a reason outside this goal; Docker cannot build; merging the worktree would conflict with `main` in a way that requires a human decision. Do not halt for effort, question count, or the number of fix-and-rerun cycles.
