---
description: Prepare project-local Agent Skills for architecture, code organization, and testing from GOAL.md.
---

`/prepare-skills`: derive a focused set of project-local Agent Skills from the goal, grounded in
current public practice, and leave no contradictions among the installed skills.

## Contract

- `<host>` is the host project: `git rev-parse --show-toplevel`; when that fails, the working
  directory. `.devboard/` and `.worktree/` are the harness, not the host; never write into them.
- `<host>/GOAL.md` is the only project-specific input. Read it once and treat its contents as the
  subject matter for every skill. Do not survey, list, or read host source code, `adrs/`,
  configuration, package manifests, build files, tests, README files, or directory trees.
  Do not infer implementation facts the goal does not state.
- Deliverable: skills under `<host>/.omp/skills/<name>/SKILL.md`, each with a directory name that
  matches its frontmatter `name`. Create nothing outside that skill root except the directories
  and `SKILL.md` files themselves.
- NEVER write, rewrite, or delete `<host>/GOAL.md`, anything under `<host>/adrs/`, or any other
  host file.
- Replace only the skills this feature owns. At the start, delete every skill directory whose
  `SKILL.md` frontmatter has `metadata.devboard-managed: "true"`. Never delete, rename, or edit a
  skill without that marker: those are hand-authored or third-party and belong to the developer.
- Install no third-party skill. `npx skills` may be used only to inspect or adapt public skill
  content while authoring; every delivered `SKILL.md` is written locally for this goal.

## Phase 1 — Goal and research

1. Read `<host>/GOAL.md`. If it is absent, empty, or whitespace-only, `halt: GOAL.md is not set`
   and nothing else.
2. Research current public best practices on the web before writing anything. Search separately
   for each of these domains and read enough sources to distinguish durable advice from fashion:
   - software architecture (boundaries, dependency direction, cohesion, coupling, interfaces);
   - code organization (modules, naming, file and layer structure, change locality);
   - testing (test boundaries, observable behavior, test doubles, regression coverage).
   Prefer primary sources, official guidance, and well-maintained references. Record what the
   sources say well enough to explain, not copy.
3. Do not fabricate research. If web access fails, `halt: web research is unavailable` and write
   no skill.

## Phase 2 — Interview when needed

Ask at most one round of questions, and only when the goal leaves a load-bearing choice open for
the skills (for example which observable surface the API serves). Use the `ask` tool with 2–5
concrete options, then continue. Do not ask about technology, language, framework, file layout,
or anything already visible in the goal. No question is required when the goal is specific enough.

## Phase 3 — Author the skills

Write at least one skill in each category and exactly these values for the marker:

| Category | `metadata.devboard-category` |
|---|---|
| Software architecture | `architecture` |
| Code organization | `code-organization` |
| Testing | `testing` |

Aim for three to six skills total. Each is one directory under `<host>/.omp/skills/` containing
one `SKILL.md`. Use this shape:

```markdown
---
name: lower-case-hyphenated-name
description: One sentence naming what the skill decides and when to use it.
metadata:
  devboard-managed: "true"
  devboard-category: architecture
---

# Title

- One actionable directive per bullet, phrased as an imperative.
- Another directive, specific to the goal's domain.
```

Rules for every skill:

- Directory name equals `name`, matches `^[a-z0-9]+(-[a-z0-9]+)*$`, and is at most 64 characters.
- `description` is non-empty, at most 1024 characters, and states the behavior the skill governs
  and when an agent should apply it.
- Body guidance is specific to the goal's domain and decisions, not generic filler such as
  "write clean code" or "test your code". A reader should be able to apply every bullet to this
  project.
- Guidance is internally consistent and complements rather than repeats the other skills.
- State directives explicitly, one policy per bullet, so a later review can compare them.

## Phase 4 — Review every installed skill

This pass is mandatory and covers every skill in `<host>/.omp/skills/`, managed or not.

1. List every skill directory and read every `SKILL.md` in it.
2. Extract the directive statements: bullets or lines beginning with a policy word such as
   `Always`, `Never`, `Must`, `Should`, `Do not`, `Avoid`, `Prefer`, or `Use`.
3. Compare each pair of skills. Two skills contradict when they state opposite policies for the
   same subject, for example "Always use dependency injection" and "Never use dependency
   injection".
4. Resolve every contradiction by rewriting a managed skill so both give compatible instructions.
   You may rephrase, narrow, merge, or delete managed skills. Never change an unmanaged skill.
5. If a contradiction cannot be resolved without changing an unmanaged skill, stop: leave the
   unmanaged file exactly as it was and `halt: unresolvable contradiction with unmanaged skill
   <name>`. Do not claim success.

## Phase 5 — Finish

- Every managed skill must carry the marker and one of the three categories, and the set must
  cover all three categories.
- The final review must have no remaining contradictions.
- Reply with a short list of the prepared skill names and `No contradictions`; never paste
  skill bodies into chat.

## Halting

`halt: <reason>` on its own line and nothing else. Reasons: `GOAL.md` is absent, empty, or
whitespace-only; web research is unavailable; the skill root cannot be written; a contradiction
with an unmanaged skill cannot be resolved without editing that skill.

NEVER halt for effort, question count, model latency, or the number of research queries.
