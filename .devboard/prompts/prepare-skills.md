---
description: Prepare project-agnostic Agent Skills grounded in relevant public standards, general best practices, software-architecture patterns, and testing patterns selected from GOAL.md.
---

## Manifesto

Your goal is to give this project a focused, project-agnostic set of Agent Skills, and the
observable result is the installed skills matching the goal with no contradictions among them.

## Contract

- `<host>` is the host project: `git rev-parse --show-toplevel`; when that fails, the working
  directory. `.devboard/` and `.worktree/` are the harness, not the host; never write into them.
- `<host>/GOAL.md` is the only project-specific input. Read it once and use it only to select which
  public standards and pattern families are relevant to the work it describes. Never copy, quote,
  paraphrase, summarize, or allude to its implementation details in a skill.
- Every skill is project-agnostic: it states policy that another project could adopt unchanged.
  Implementation decisions stay with the implementation agent, never with a skill.
- Do not survey, list, or read host source code, `adrs/`, configuration, package manifests, build
  files, tests, README files, or directory trees. Do not infer implementation facts the goal does
  not state, and do not ask the developer for them.
- Deliverable: skills under `<host>/.omp/skills/<name>/SKILL.md`, each with a directory name that
  matches its frontmatter `name`. Create nothing outside that skill root except the directories and
  `SKILL.md` files themselves.
- NEVER write, rewrite, or delete `<host>/GOAL.md`, anything under `<host>/adrs/`, or any other
  host file.
- Replace only the skills this feature owns. At the start, delete every skill directory whose
  `SKILL.md` frontmatter has `metadata.devboard-managed: "true"` and does not carry
  `metadata.devboard-family: "discover"`. A managed skill with no `metadata.devboard-family` field
  belongs to this prepare family for backward compatibility. Never delete, rename, or edit a skill
  that does not belong to this family, including a Discover-family skill: the Discover family is
  project-specific, owned by Discover, and belongs to the developer once it is published.
- Install no third-party skill. `npx skills` may be used only to inspect or adapt public skill
  content while authoring; every delivered `SKILL.md` is written locally for this goal.

## Phase 1 — Goal and research

1. Read `<host>/GOAL.md`. If it is absent, empty, or whitespace-only, `halt: GOAL.md is not set`
   and nothing else.
2. Treat the goal as a selection signal only: decide which standards and pattern families it makes
   relevant. Never turn a statement from it into a skill directive.
3. Research current public practice on the web before writing anything. Search separately in each
   of these areas and read enough sources to distinguish durable guidance from fashion:
   - public standards and specifications from authoritative bodies, such as RFCs, ISO or IEEE
     standards, and standards-organization guidance;
   - general engineering best practices that apply regardless of stack or organization;
   - software-architecture patterns: boundaries, dependency direction, cohesion, coupling,
     interfaces, layering;
   - testing patterns: test boundaries, observable behavior, test doubles, regression coverage.
   Prefer primary sources and official guidance. Record what the sources say well enough to explain
   it, not to copy it.
4. Do not fabricate research. If web access fails, `halt: web research is unavailable` and write no
   skill.

## Phase 2 — Choose the skills

Decide how many skills to prepare and what each one covers. Base the choice on the standards and
pattern families the goal makes relevant, not on a fixed taxonomy. At least one skill is required;
there is no maximum and no required topic. Each skill covers one coherent family so another project
can adopt it unchanged.

## Phase 3 — Interview when needed

Ask at most one round of questions, and only when the goal leaves open which standards or pattern
families matter for the prepared skills. Use the `ask` tool with 2–5 concrete options, then
continue. Do not ask about technology, language, framework, or file layout, and never ask for
implementation detail the goal does not state. No question is required when the goal is specific
enough.

## Phase 4 — Author the skills

Write at least one skill. Each is one directory under `<host>/.omp/skills/` containing one
`SKILL.md`. Use this shape:

```markdown
---
name: lower-case-hyphenated-name
description: One sentence naming the policy the skill states and when to apply it.
metadata:
  devboard-managed: "true"
  devboard-family: "prepare"
---

# Title

- One portable policy per bullet, phrased as an imperative.
- Another policy drawn from a public standard or a named pattern.
```

Rules for every skill:

- It is project-agnostic: another project with a different stack can adopt every directive
  unchanged.
- It contains no project-specific implementation detail: no host or product name, no repository or
  absolute path, no host directory or file name, no module, class, function, type, package,
  dependency, framework, runtime, library, or programming language, no data format, API shape,
  schema, or configuration key, and no concrete architecture, layout, or design decision.
- Public domain names, formats, and standard identifiers are allowed when they are the subject of
  the guidance, such as an RFC number, a named standard, or a protocol defined by a public body.
- Directory name equals `name`, matches `^[a-z0-9]+(-[a-z0-9]+)*$`, and is at most 64 characters.
- `description` is non-empty, at most 1024 characters, and states the policy the skill governs and
  when an agent should apply it.
- Body guidance states durable policy grounded in the researched standards and patterns, not
  generic filler such as "write clean code" or "test your code".
- Guidance is internally consistent and complements rather than repeats the other skills.
- State directives explicitly, one policy per bullet, so a later review can compare them.
- A skill carries no provenance line, source list, or citation field; the research informs the
  policy and stays out of the delivered file.

## Phase 5 — Review every installed skill

This pass is mandatory and covers every skill in `<host>/.omp/skills/` that belongs to this
prepare family, plus every hand-authored skill without a `devboard-managed` marker. It never reads
a skill whose frontmatter carries `metadata.devboard-family: "discover"`: Discover's
project-specific policy is not measured against project-agnostic preparation.

1. List every skill directory and read every `SKILL.md` in it.
2. Extract the directive statements: bullets or lines beginning with a policy word such as
   `Always`, `Never`, `Must`, `Should`, `Do not`, `Avoid`, `Prefer`, or `Use`.
3. Compare each pair of skills. Two skills contradict when they state opposite policies for the
   same subject, for example "Always use dependency injection" and "Never use dependency
   injection".
4. Resolve every contradiction by rewriting a skill of this prepare family so both give compatible
   instructions. You may rephrase, narrow, merge, or delete prepare-family skills. Never change an
   unmanaged skill or a Discover-family skill.
5. If a contradiction cannot be resolved without changing an unmanaged skill, stop: leave the
   unmanaged file exactly as it was and `halt: unresolvable contradiction with unmanaged skill
   <name>`. Do not claim success.

## Phase 6 — Finish

- Every skill of this family must carry both markers, and the prepare family must contain at least
  one skill.
- The final review must have no remaining contradictions.
- Reply with a short list of the prepared skill names and `No contradictions`; never paste skill
  bodies into chat.

## Halting

`halt: <reason>` on its own line and nothing else. Reasons: `GOAL.md` is absent, empty, or
whitespace-only; web research is unavailable; the skill root cannot be written; a contradiction with
an unmanaged skill cannot be resolved without editing that skill.

NEVER halt for effort, question count, model latency, or the number of research queries.
