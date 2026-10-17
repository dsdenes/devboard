# AGENTS.md

Two layers. Identify yours before reading or editing.

```
<repo root>/
  .devboard/   <- harness
  ...          <- host project
```

| Path | Identity |
| --- | --- |
| `.devboard/` | Agentic development harness. Project-agnostic. Works *on* the host. Never the host product. |
| everything else | Host project. |

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

1. **Containment.** Keep every harness file inside `.devboard/`: code, scripts, prompts, tests, fixtures, docs, configs, CI glue, artifacts. Asked to place one outside? Refuse; propose the `.devboard/` path. Host files *invoking* the harness at runtime are fine.
2. **Portability.** Harness code moves between unrelated hosts. Bake in nothing host-specific: no absolute paths, project names, identifiers, remotes, secrets, language/layout/build/test-runner assumptions. Discover host facts at runtime, take them as arguments, or read them from config under `.devboard/`. Emit host paths relative to the repo root.
3. **Fixed location, fixed name.** Install at `<repo root>/.devboard`, spelled exactly that. Never rename or relocate per host.
4. **Host-neutral deletion.** Deleting `.devboard/` must leave host build, tests, and run paths working. No host hard-dependency on the harness beyond `.devboard/` itself.
5. **The one exception.** `AGENTS.md` sits at the repo root by design: agents must find it there. Host-agnostic, copied verbatim between hosts, not a harness artifact. Nothing else gets this treatment.

## Cross-boundary changes

Split, never mix: host-specific detail in host files; generic mechanism in `.devboard/` taking that detail as input. A host name, path, or stack inside `.devboard/` is a bug. A harness dependency outside it is a bug.

## Worktree

Do all work — host and harness — in an isolated git worktree: `<repo root>/.worktree/<name>`. Never outside the repo root. Never edit the opened checkout. One worktree per task; edit, build, and test inside it. Done means merged directly into main. Then delete the worktree and its branch.

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

- `.devboard/` — harness root.
- `.devboard/AGENTS.md` — harness-internal instructions, when present.
- `.worktree/` — per-task worktrees; ephemeral.
- `AGENTS.md` — harness ⇄ host contract; at repo root by design.
