# Design-system reference

This file is the implementation contract for `DESIGN.md`, DTCG, OpenUI, Storybook CSF, and the
designmd.ai MCP. Read it at Step 4 or Step 5.

## 1. DESIGN.md is the source of truth

`DESIGN.md` lives at the project root. It follows the Google DESIGN.md format at
<https://github.com/google-labs-code/design.md> (currently `alpha`).

A compliant file has two layers:

1. **Machine-readable YAML tokens** — YAML front matter at the top and/or interleaved fenced
   `yaml` blocks inside sections. Each top-level token key appears at most once across the file.
2. **Human-readable markdown rationale** — `##` sections in the canonical order.

Tokens are normative. Prose explains how to apply them. If prose and tokens disagree, fix the
file; do not let the implementation pick a side silently.

### Required token shape

```yaml
---
version: alpha
name: <design-system-name>
description: <one-line purpose>
colors:
  <token-name>: <CSS color>
typography:
  <token-name>:
    fontFamily: <string>
    fontSize: <dimension>
    fontWeight: <number>
    lineHeight: <dimension | number>
    letterSpacing: <dimension>
spacing:
  <scale-level>: <dimension | number>
rounded:
  <scale-level>: <dimension>
components:
  <component-name>:
    backgroundColor: "{colors.<token>}"
    textColor: "{colors.<token>}"
    typography: "{typography.<token>}"
    rounded: "{rounded.<token>}"
    padding: <dimension>
    size: <dimension>
    height: <dimension>
    width: <dimension>
---
```

Token references use `{path.to.token}`. Component variants are separate entries with related keys
(`button-primary`, `button-primary-hover`). Do not invent component properties; the allowed set is
`backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height`, `width`.

### Canonical section order

Sections may be omitted when not applicable, but present sections must appear in this order:

1. Overview (or Brand & Style)
2. Colors
3. Typography
4. Layout (or Layout & Spacing)
5. Elevation & Depth (or Elevation)
6. Shapes
7. Components
8. Do's and Don'ts

Do not duplicate a section heading. Do not duplicate a top-level YAML key.

### Layout and spacing conventions are mandatory

Even when other sections are omitted, `## Layout` must exist and must state the spacing system.
Include:

- base unit (for example `4px`);
- approved scale;
- preferred rhythm (for example `8px` for macro spacing);
- component padding conventions;
- layout gaps;
- section spacing;
- container widths and gutters;
- responsive spacing rules;
- forbidden or exception values;
- the mapping to `spacing.*` tokens.

Minimal pattern:

```md
## Layout

Spacing uses a 4px base unit. The approved scale is 4, 8, 12, 16, 24, 32, 48, 64px.
Use 8px as the default macro rhythm. Component padding: 8×12px small, 12×16px medium,
16×24px large. Layout gaps: 8px compact, 16px default, 24px section. Section spacing:
32px mobile, 48px tablet, 64px desktop. Container: max-width 1280px with 24px gutters.
Responsive: collapse multi-column gaps to the next lower scale step. Do not use
arbitrary values outside the scale; add a token instead.

Spacing tokens: `{spacing.xs}` 4px, `{spacing.sm}` 8px, `{spacing.md}` 16px,
`{spacing.lg}` 24px, `{spacing.xl}` 32px, `{spacing.2xl}` 48px, `{spacing.3xl}` 64px.
```

The preflight script rejects a `DESIGN.md` without a Layout section that describes spacing.

### Validate and project

Run from the project root:

```bash
npx --yes @google/design.md@0.4.0 lint --format json DESIGN.md
npx --yes @google/design.md@0.4.0 export --format dtcg DESIGN.md > design/tokens.json
```

`lint` must report zero errors. Treat warnings as review items; do not ignore contrast or broken
token-reference findings. Use `diff` before changing an established design system:

```bash
npx --yes @google/design.md@0.4.0 diff DESIGN.md DESIGN.before.md
```

DTCG is the exchange artifact. Generate it from `DESIGN.md`; do not hand-edit a generated
`design/tokens.json`. If the project cannot generate DTCG, keep a checked-in DTCG file and prove it
matches the DESIGN.md tokens with a diff or a focused test.

## 2. DTCG

DTCG uses `$value`, `$type`, `$description`, `$extensions`, and nested groups. A minimal valid
shape:

```json
{
  "$schema": "https://www.designtokens.org/schemas/2025.10/format.json",
  "color": {
    "primary": { "$type": "color", "$value": "#1A1C1E" },
    "background": { "$type": "color", "$value": "#FFFFFF" }
  },
  "spacing": {
    "sm": { "$type": "dimension", "$value": "8px" }
  }
}
```

Rules:

- One token source of truth: `DESIGN.md`. DTCG is a projection.
- Keep names stable; renaming a token is a breaking change.
- Do not add a DTCG token that does not exist in `DESIGN.md` unless the project explicitly keeps a
  larger token set and `DESIGN.md` is a documented subset. State the authority in the file.
- Never let OpenUI or Storybook consume a different token file than the one documented here.

## 3. OpenUI component catalog

Use the OpenUI specification at <https://openuispec.org/spec> (draft-01). This is the
machine-readable component catalog, not the OpenUI Lang generative-UI language.

The catalog is `openui.json` or `openui.yaml` at the project root. Required shape:

```yaml
name: <library-name>
version: <version>
description: <purpose>
components:
  Button:
    description: <what it is for>
    package: <optional import path>
    example: |
      <Button variant="primary">Save</Button>
    props:
      variant:
        type: string
        description: Visual emphasis.
        enum: [primary, secondary, ghost]
        default: primary
      disabled:
        type: boolean
        description: Prevents interaction.
        default: false
```

Rules:

- Every component used by the page must have an OpenUI entry. Missing entry = declare a requirement.
- Props must match the real implementation: names, types, defaults, enums, required flags.
- Describe events and accessibility behavior in `description` or `example` when the schema has no
  event field. Do not invent a parallel prop system.
- Examples must be executable or directly adaptable, not pseudocode.
- Do not list a component that is only a visual alias of another. Use composition.
- Update OpenUI in the same change as the component implementation.

## 4. Storybook CSF

Use Storybook Component Story Format 3.x. The default export is the meta; named exports are
stories. The example below uses React; use the project's actual framework renderer and CSF package.

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./Button";

const meta = {
  title: "Actions/Button",
  component: Button,
  args: { variant: "primary", children: "Save" },
  argTypes: {
    variant: { control: "select", options: ["primary", "secondary", "ghost"] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const Loading: Story = { args: { loading: true } };
export const Error: Story = { args: { error: "Could not save" } };
```

Rules:

- Every OpenUI component has at least one CSF story.
- Cover the states the component actually has: default, loading, empty, error, disabled,
  permission-denied, long content, narrow container, and destructive variants.
- Stories are executable examples, not screenshots. Use real props and real data shapes.
- Use `@storybook/test` play functions for interaction states only when the project already has
  them; do not add a test dependency just to satisfy this skill.
- A story that cannot render is a broken prerequisite. Fix it before wiring the page.
- If Storybook lacks a component story, Step 5 adds it; the preflight only requires Storybook
  config plus at least one CSF story.

## 5. designmd.ai MCP research

The session's MCP configuration provides the `designmd` server. The exposed tool names are:

- `mcp__designmd_search_design_kits`
- `mcp__designmd_get_design_kit`
- `mcp__designmd_list_popular_kits`
- `mcp__designmd_list_tags`
- `mcp__designmd_download_design_kit`
- `mcp__designmd_upload_design_kit`
- `mcp__designmd_delete_design_kit`

Use only the first four for normal design work. Do not upload or delete without an explicit user
request. `download_design_kit` writes a file; use it only for an explicitly requested bootstrap.

### Required procedure before a design-system mutation

1. Call `mcp__designmd_search_design_kits` with a query that describes the product, audience, and
   visual intent (not just "design system"). Add tags and sort when useful.
2. Call `mcp__designmd_get_design_kit` for one or two relevant candidates. Read the content as
   evidence; do not copy a kit wholesale into an existing system.
3. If the query is about direction rather than a named kit, use `mcp__designmd_list_tags` or
   `mcp__designmd_list_popular_kits`.
4. Write `.design/research/<YYYY-MM-DD>-<slug>.md`:

```md
# designmd.ai research

- Task:
- Tools and arguments:
- Candidates (include designmd.ai URLs):
- Adopted:
- Rejected:
- Why:
- Effect on DESIGN.md / tokens / components:
```

5. If the MCP server is unavailable, unauthenticated, or returns an error, do not mutate design
   system artifacts. Report the failure and continue only with work that does not require a
   design-system change.

The MCP tool descriptions require kit URLs in user-facing responses. Include them.

## 6. Component selection and sync

At Step 4, read the OpenUI catalog and Storybook index before reading component source. The order is:

1. Can an existing component be reused with existing props? Reuse.
2. Can existing primitives be composed? Compose.
3. Does an existing component need a real, reusable extension? Modify at the source.
4. Only then create a new component.

New components need a reason that survives six months: a distinct semantic role, a distinct
accessibility contract, or a data shape the existing primitives cannot carry. "It is easier to
fork" is not a reason.

Step 5 sync checklist:

- [ ] Component implementation matches the OpenUI entry.
- [ ] Storybook story covers default and all relevant states.
- [ ] Tokens used by the component exist in `DESIGN.md`.
- [ ] `design/tokens.json` regenerated or diffed against `DESIGN.md`.
- [ ] `npx @google/design.md@0.4.0 lint --format json DESIGN.md` has zero errors.
- [ ] OpenUI catalog parses and the component entry has props/examples.
- [ ] Storybook builds or the targeted story tests pass.
- [ ] No stale prop, token, or story references remain.

If any surface disagrees, the component is not done.
