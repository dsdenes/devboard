---
name: devboard-ui-ux
description: >-
  Opinionated, gate-first UI/UX workflow. MUST load before any task that creates,
  redesigns, reviews, or implements a user-facing interface, including pages,
  screens, layouts, navigation, forms, tables, dashboards, components, design
  systems, design tokens, wireframes, Storybook stories, OpenUI catalogs, A2UI,
  or frontend styling. Enforces user journeys, information selection, weighted
  significance, A2UI wireframes, OpenUI component discovery, Storybook CSF
  states, DESIGN.md, DTCG, designmd.ai MCP research, and Playwright validation.
  Do not use for backend-only work, data pipelines, or non-visual CLIs.
metadata:
  devboard-builtin: "true"
---

# UI/UX

This skill is a gate, not a suggestion. It decides what information earns attention, how it is
structured, which components carry it, and whether the result actually works in a browser.

Load it automatically for UI/UX work; do not wait for `/skill:devboard-ui-ux`. If the preflight gate
fails, the workflow does not apply, but the user's underlying task is not blocked.

## 0. Preflight gate

Run this before inspecting UI code, proposing a redesign, or touching a design-system artifact:

```bash
bun "$(realpath skill://devboard-ui-ux)/scripts/preflight.mjs" .
```

The script prints JSON. Read `applicable`, `checks`, and `missing`.

### If `applicable` is false

Print the following once, then continue the original task with normal engineering judgment.
Do not run this skill's steps. Do not create the missing prerequisites unless the user explicitly
asks for a separate bootstrap task.

```text
UI/UX skill not applied.

Missing or invalid UI/UX stack prerequisites:
- <requirement>: <status and detail>
- ...

Remediation:
- <exact command or file change for each missing item>

The underlying task is not blocked. Continue with normal engineering judgment.
No design-system mutation, A2UI wireframe, or Playwright validation claim was produced by this skill.
```

### If `applicable` is true

Read the reference for the step you are on. Do not read every reference up front.

- `skill://devboard-ui-ux/references/design-system.md` — DESIGN.md, DTCG, OpenUI, Storybook CSF, MCP.
- `skill://devboard-ui-ux/references/wireframe.md` — A2UI and the standalone wireframe.
- `skill://devboard-ui-ux/references/validation.md` — Playwright, dependent pages, spacing, visual checks.
- `skill://devboard-ui-ux/references/templates.md` — artifact templates.

## Hard rules

1. **Step order is mandatory.** Do not choose information, layout, components, colors, fonts, or
   styles before the step that owns that decision. Each step lists what is out of scope; obey it.
2. **One source of truth.** `DESIGN.md` is normative for tokens and design rationale. DTCG, the
   OpenUI catalog, Storybook stories, and implementation are synchronized projections or consumers.
   Never create a second token source of truth.
3. **Research before mutation.** Before creating or changing any design-system artifact or
   component, call the `designmd` MCP server and record the research. Read-only inspection does not
   require MCP. No MCP evidence, no design-system mutation.
4. **The wireframe is not the product.** Step 3 uses A2UI and neutral wireframe primitives only.
   It must not import production components, production CSS, brand fonts, brand colors, or tokens.
5. **Composition over inheritance.** Reuse or compose existing components before adding variants.
   A new component is the last option, not the first.
6. **OpenUI and Storybook are the discovery surfaces.** Do not guess component APIs from filenames
   or screenshots. Use the catalog and its executable stories.
7. **No visual claim without browser evidence.** Final validation uses Playwright. If it cannot run,
   report the gap; never imply the UI was visually verified.
8. **Missing prerequisites disable this workflow, not the task.** Follow the preflight behavior
   above. Do not silently weaken the requirements or pretend the gate passed.
9. **Never upload or delete designmd kits without an explicit user request.** Search and read are
   safe. Downloading writes a file; only do it for an explicitly requested bootstrap.
10. **Artifacts stay inside the project root.** The default layout is `DESIGN.md` and `openui.json`
    at the root, DTCG at `design/tokens.json`, and workflow output under `.design/`.

## Artifact layout

Use a kebab-case page slug derived from the route or page name (for example `settings-billing`).

```text
DESIGN.md                                  # normative design system
design/tokens.json                         # DTCG exchange artifact
openui.json | openui.yaml                  # OpenUI component catalog
.design/ux/<slug>/brief.md                 # Step 0
.design/ux/<slug>/content-inventory.md     # Step 1
.design/ux/<slug>/significance.md          # Step 2
.design/ux/<slug>/structure.md             # Step 3
.design/a2ui/<slug>.a2ui.jsonl             # Step 3
.design/a2ui/<slug>.wireframe.html         # Step 3
.design/ux/<slug>/component-requirements.md# Step 4
.design/ux/<slug>/validation.md            # Final validation
.design/research/<date>-<slug>.md          # MCP research receipts
```

If the project already has a documented equivalent location, use it and state the mapping. Do not
duplicate an artifact in two locations.

## Step 0 — Goal and user journeys

Determine why the page exists and how the user arrives. Infer from source code, routes, API
contracts, docs, tests, analytics, and surrounding pages. Do not ask for facts the repository
already answers.

Write `.design/ux/<slug>/brief.md` with:

- **Page identity:** route, title, auth/role, entry points.
- **Primary goal:** the job the page exists to complete, and the observable success signal.
- **Secondary goals:** only if they do not compete with the primary goal.
- **Arrival context:** what the user knows, what they carry in, prior page or state, device and
  network assumptions, urgency.
- **Relationship to other pages:** upstream, downstream, loops, and the state left behind.
- **User journeys:** at least one realistic journey. For multi-action pages, one per meaningful
  action. Each journey has trigger, steps, decision points, success, failure routes, recovery, and
  exit.
- **Non-goals:** what this page deliberately does not do.
- **Assumptions:** mark inferred facts that matter.

Failure routes are not optional decoration. Cover validation failure, permission denied, empty
data, partial data, network failure, timeout, destructive confirmation, and stale state when they
are plausible.

**Out of scope for this step:** information to show, UI elements, components, design kit, colors,
styles, fonts. Do not mention them in `brief.md`.

## Step 1 — What to show

Before deciding how anything looks, decide which information deserves to exist. Data being
available is not a reason to display it.

On a redesign, treat the current page as evidence, not a constraint. Unless the user explicitly
says to preserve it, you may remove, replace, merge, split, or reorder every piece of existing
data. Preserve only information required by a declared journey or by a hard contract (legal,
financial, safety, or explicit user instruction). "It is already on the page" is not a reason.

Write `.design/ux/<slug>/content-inventory.md` with a candidate table:

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|

For every candidate, ask:

> If this is removed, does the user lose the ability to make a declared decision or complete a
> declared journey?

If the answer is no, omit it. Keep the inventory ruthless: less is more. KISS.

Rules:

- Do not show a value merely because the API returns it.
- Do not duplicate the same fact in different forms.
- Prefer the source of truth over a derived copy.
- Do not expose internal identifiers, raw errors, or implementation details unless the journey
  requires them.
- Do not invent urgency, social proof, or metrics that the source does not support.
- Resolve conflicting sources explicitly; record which one wins and why.

**Out of scope for this step:** UI elements, components, design kit, colors, styles, fonts. This
step is about information, not presentation.

## Step 2 — Significance inventory

Score every retained item. The score is about information importance, not visual size.

Write `.design/ux/<slug>/significance.md` with one row per item:

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---|---|---|---|---|---|---|---|

Dimensions and weights:

| Dimension | Weight | Question |
|---|---:|---|
| Goal impact | 35% | Does it directly advance the primary or a declared secondary goal? |
| Action/decision criticality | 25% | Is it needed to choose or act, especially for irreversible, financial, or safety actions? |
| Frequency/urgency | 15% | How often is it needed, and how time-sensitive is it? |
| Uniqueness | 15% | Does it convey something no other retained item conveys? |
| Risk/trust | 10% | Does it carry compliance, privacy, money, destructive-action, or trust weight? |

Score each dimension from 0 to 5. Compute:

```text
score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)
```

Bands:

- **P0, 80–100:** primary; must be present in the first screen or the critical path.
- **P1, 60–79:** secondary; present in the main flow or one interaction away.
- **P2, 40–59:** supporting; progressive disclosure or details.
- **P3, 20–39:** optional; omit unless the journey proves otherwise.
- **Drop, below 20:** remove.

Deduplicate again after scoring. If two items enable the same decision, keep the one with the
higher score and the better source of truth. Remove vanity metrics and redundant summaries.

**Out of scope for this step:** UI elements, components, design kit, colors, styles, fonts.

## Step 3 — Structure

Turn the journeys and significance inventory into an information structure. Read
`skill://devboard-ui-ux/references/wireframe.md` before writing the A2UI file.

Write:

- `.design/ux/<slug>/structure.md` — regions, order, grouping, hierarchy, actions, state coverage,
  responsive priority, and rationale tied to journey/score IDs.
- `.design/a2ui/<slug>.a2ui.jsonl` — A2UI v0.9.1 by default, or the project's pinned version.
- `.design/a2ui/<slug>.wireframe.html` — standalone rendered wireframe.

Structure rules:

- One primary task per page. Put P0 on the first screen or the critical path.
- Group by user decision or action, not by data source or database table.
- Put P1 in the main flow; P2 behind disclosure; omit P3 unless the journey proves it.
- Minimize containers. Every extra region must earn its place.
- Define loading, empty, error, partial, permission-denied, and success states when relevant.
- Define the mobile order and what collapses or moves.
- Remove duplicate information and redundant summaries.

Wireframe rules:

- A2UI is the structural source; the HTML is a rendering of the same structure.
- Use only A2UI basic-catalog component names. Do not invent component types.
- Use neutral wireframe primitives: boxes, labels, placeholder text, grayscale, system font.
- No production components, imports, CSS variables, brand colors, brand fonts, shadows, or icons.
- The wireframe must be readable as structure, not mistaken for a visual design.

**Out of scope for this step:** production components, design kit, brand colors, styles, fonts,
motion, and final spacing tokens. Wireframe primitives are structural placeholders, not a design.

## Step 4 — Choose or implement required components

Use OpenUI to discover what exists, then decide per need. Read
`skill://devboard-ui-ux/references/design-system.md` for the catalog and Storybook rules.

Write `.design/ux/<slug>/component-requirements.md` with one row per component need:

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|

Decision vocabulary:

- **Reuse:** the existing component and props satisfy the need.
- **Modify:** a real, reusable extension is needed; keep the API coherent.
- **Compose:** combine existing primitives; preferred over new variants.
- **New:** no existing component or composition can carry the need.

For every requirement, include the full data variety the component must survive:

- empty, loading, error, partial, permission-denied;
- zero, one, many; long text; large numbers; missing/null fields;
- high cardinality; narrow and wide containers;
- destructive, financial, or irreversible actions;
- localization, RTL, and reduced motion when the product supports them.

Do not wire the page yet. If a needed component is not in OpenUI, declare the catalog addition. If
it is present, cite the exact entry. If a component needs design-system changes, Step 5 owns them.

## Step 5 — Implement required components

Implement or modify components separately from the page. Read
`skill://devboard-ui-ux/references/design-system.md` for the sync contract.

Before the first design-system mutation, run the designmd research procedure and write
`.design/research/<date>-<slug>.md`. No research receipt, no mutation.

Then:

1. Implement the component with composition over inheritance.
2. Add or update its Storybook CSF story, including the states and edge cases from Step 4.
3. Add or update its OpenUI catalog entry, including props, enums, defaults, and examples.
4. If tokens changed, update `DESIGN.md` and regenerate DTCG from it.
5. Run the local validation commands for lint, catalog parsing, and Storybook.

A component is not done until these agree: implementation, `DESIGN.md` (when tokens changed),
`design/tokens.json`, OpenUI, and Storybook CSF. Do not leave a stale projection.

## Step 6 — Wire together

Use design-system components to assemble the page. Do not fork a component for a local page need;
if the component must change, return to Step 4/5 and change it at the source.

Validate with high-variety data and the journeys from Step 0:

- empty, loading, error, partial, permission-denied, success;
- long text, large numbers, missing fields, high cardinality;
- zero, one, many;
- narrow and wide viewports;
- destructive and irreversible actions;
- keyboard and focus paths.

Check for duplicate information, arbitrary spacing, overflow, clipped labels, and layout shifts.
If a local use case exposes a component gap, fix the component and its stories rather than patching
the page.

## Final validation

Read `skill://devboard-ui-ux/references/validation.md` and follow it. At minimum:

- Run the app using the project's documented command; do not guess a server command.
- Use Playwright (the project's `@playwright/test` or OMP's browser tool) to exercise the primary
  and failure journeys.
- Capture desktop and mobile evidence for default, loading, empty, error, and key edge states.
- If a design-system component changed, check every dependent page.
- Check duplicate information.
- Check visible UI glitches: clipping, overlap, overflow, misalignment, empty containers, scroll
  traps, layout shift.
- Check padding, margins, and gaps against the `DESIGN.md` spacing conventions; no arbitrary values.
- Check focus visibility, keyboard order, labels, error announcements, contrast, and reduced motion.
- Check console errors and failed network requests.
- Record commands, viewports, states, evidence paths, and pass/fail in
  `.design/ux/<slug>/validation.md`.

If a check was not run, write `not run` and why. Never claim visual verification without evidence.

## References

- `skill://devboard-ui-ux/references/design-system.md`
- `skill://devboard-ui-ux/references/wireframe.md`
- `skill://devboard-ui-ux/references/validation.md`
- `skill://devboard-ui-ux/references/templates.md`
