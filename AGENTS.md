# AGENTS.md

Two layers. Identify yours before reading or editing.

```
<repo root>/
  .devboard/   <- harness: interface, prompts, wrappers, install.sh
  adrs/        <- host data
  GOAL.md      <- host data
  .omp/        <- installed harness wrappers
  ...          <- host project
```

| Path | Identity |
| --- | --- |
| `.devboard/` | Agentic development harness. Project-agnostic. Owns the browser interface and its toolchain. Works *on* the host. Never the host product. |
| `.devboard/omp/` | Canonical agent wrappers; installed into the host's `.omp/`. |
| `adrs/`, `GOAL.md` | Host data at the root; never harness artifacts. |
| everything else | Host project. |

## Containment boundary

The whole project — host, harness, toolchain, tests, fixtures, caches, logs, temporary
files, and worktrees — lives inside `<repo root>`. Nothing may be created, written, or kept
outside it: not under `/tmp`, not in a home directory, not in a parent, sibling, or other
checkout. This applies to every agent, script, and service, including throwaway
verification, "safe" sandbox copies, and manual test data.

- Point every path variable (`ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`) at a
  location inside `<repo root>`.
- When a tool defaults outside the root, override it to a directory inside the root; never
  accept the default.
- Asked to place a file, artifact, cache, log, or worktree outside the root? Refuse and
  propose the in-repo path.
- Running system binaries (`bun`, `git`, `gh`, `omp`) is not a violation; writing their
  output outside the root is.

A temporary directory is still project data. Create it under `<repo root>` (for example
under `.worktree/`), never outside.

## Scope

Default to the host project. "the repo", "the project", "the code", and unnamed files all mean the host project.

Enter harness mode only when the request names the harness, "devboard", or a path inside `.devboard/`.

| Mode | Trigger | Edit |
| --- | --- | --- |
| host (default) | everything else | host project; leave `.devboard/` untouched |
| harness | explicit harness / `.devboard` reference | `.devboard/` only; host files untouched unless named |

A request naming both layers is two scopes; change each side by its own rules.
Never edit `.devboard/` for a host request. Never edit host files for a harness request. If a task couples them, surface it and state the scope change.

## Harness rules

1. **Containment.** Keep every harness file inside `.devboard/`: code, scripts, prompts, tests, fixtures, docs, configs, CI glue, artifacts. Nothing harness-related is created outside `<repo root>` — no temporary files, caches, logs, or test data. Asked to place one outside? Refuse; propose the `.devboard/` path. Host files *invoking* the harness at runtime are fine.
2. **Portability.** Harness code moves between unrelated hosts. Bake in nothing host-specific: no absolute paths, project names, identifiers, remotes, secrets, language/layout/build/test-runner assumptions. Discover host facts at runtime, take them as arguments, or read them from config under `.devboard/`. Emit host paths relative to the repo root.
3. **Fixed location, fixed name.** Install at `<repo root>/.devboard`, spelled exactly that. Never rename or relocate per host.
4. **Host-neutral deletion.** Deleting `.devboard/` must leave host build, tests, and run paths working. No host hard-dependency on the harness beyond `.devboard/` itself.
5. **The one exception.** `AGENTS.md` sits at the repo root by design: agents must find it there. Host-agnostic, copied verbatim between hosts, not a harness artifact. Nothing else gets this treatment.

## Interface

`.devboard/` owns the browser interface and everything needed to build, test, and run it: the Bun
server, the Svelte client, the tests and fixtures, `package.json`, `bun.lock`, the build
configuration, `index.html`, the `Dockerfile`, and `README.md`. Run its commands from `.devboard`:
`bun install`, `bun test`, `bun run build`, `bun run start`; build the container from the
`.devboard` context. The interface is a harness tool, not the host product.

The harness may define its own toolchain, but it must not assume host facts: no host language,
package manager, test runner, build system, or layout. Host data lives at the root — the decision
records in `adrs/` and the goal document `GOAL.md` — and reaches the interface only through paths
the host supplies: `ADRS_DIR`, `REPO_DIR`, `GOAL_FILE`, `STATIC_DIR`, `AGENT_COMMAND`. The
lifecycle prompts under `.devboard/prompts/` likewise treat the repository root as the host and
exclude `.devboard/` and `.worktree/` from every survey and every write.

## Wrappers

`.devboard/omp/` is canonical: agent commands live in `omp/commands/` and extensions in
`omp/extensions/`, never in the root `.omp/`. `.devboard/install.sh` copies every file under
`.devboard/omp/` to the same relative path under `<host>/.omp/`. The host path is an argument or
is discovered with `git rev-parse --show-toplevel`; the script refuses a host without a
`.devboard/` directory, refuses to overwrite a differing file without `--force`, never touches
unrelated files, and is safe to rerun. Edit `.devboard/omp/`, rerun `install.sh`, and never
hand-edit the installed `.omp/`.

## Cross-boundary changes

Split, never mix: host-specific detail in host files; generic mechanism in `.devboard/` taking that detail as input. A host name, path, or stack inside `.devboard/` is a bug. A harness dependency outside it is a bug.

## Worktree

Do all work — host and harness — in an isolated git worktree: `<repo root>/.worktree/<name>`. Never outside the repo root. Never edit the opened checkout. One worktree per task; edit, build, and test inside it. Done means merged directly into main. Then delete the worktree and its branch.

## Line length

Never create a line longer than 768 bytes (UTF-8) in a repository text file. Hard-wrap
prose, prompts, and Markdown list items; do not rely on a later reader re-opening a
truncated line. Aim for 100 columns or less. Generated files such as lockfiles are exempt;
never hand-edit them.

## Working rules

- State mode and edit root before the first edit.
- Decide which side a new file belongs on first. Two common bugs: a harness artifact in host code, a host fact baked into `.devboard/`.
- Run harness work from the repo root with the host path passed in or discovered at runtime.
- In harness mode, never "temporarily" write outside `.devboard/`; fix the layering.
- Host mode leaves `.devboard/` byte-identical. Harness mode leaves host behavior unchanged except where asked.

## Done

- Both modes: done in `.worktree/<name>`, merged to main, worktree and branch removed.
- Host mode: host build/tests run; `.devboard/` unchanged.
- Harness mode: the changed entry point runs from the repo root against a supplied host path; no absolute paths or host specifics under `.devboard/`; nothing created outside `.devboard/`.

## Map

- `.devboard/` — harness root: interface, toolchain, prompts, extensions, goals, tests, `omp/`, `install.sh`.
- `.devboard/omp/` — canonical agent commands and extensions.
- `.omp/` — installed copy of `.devboard/omp/`; never edited by hand.
- `adrs/`, `GOAL.md` — host data at the root; not harness artifacts.
- `.devboard/AGENTS.md` — harness-internal instructions, when present.
- `.worktree/` — per-task worktrees; ephemeral.
- `AGENTS.md` — harness ⇄ host contract; at repo root by design.
