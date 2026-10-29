# Auto Scout agent header — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Header frame, identity row, secondary band | Modify `PageHeader` | `PageHeader` (adds `footer`, documents `layout`) | `Design System/PageHeader` → `BarWithFooter` | `bar` with and without a footer; long title; long subtitle; 300px identity floor; 1024px and 2100px workspace | Native `<header>`; one `h1`; title never truncates; footer is a sibling of the row, not inside the heading | Existing `surface`, `border`, `border-subtle`, spacing, typography |
| Start/Stop | Reuse `Button` | `Button` | Covered by the primitive's stories | `stopped`/`failed` → Start; `running`/`stopping` → Stop (disabled while stopping); disconnected or legacy-timer block disables Start; another dashboard's worker is not stoppable | Native button, visible focus, disabled non-interactive at 45% | `primary`, `primary-hover`, `primary-foreground` |
| Lifecycle word | Compose `.badge` | — (CSS primitive) | Existing badge specimens | `stopped`, `starting`, `running`, `stopping`, `failed`; tone from `statusTone`; never a state without a word | Text carries the state; tone is redundant | Existing `success`/`warning`/`error`/`accent`/`muted-foreground` |
| Forge sync word | Compose `.badge` | — (CSS primitive) | Existing badge specimens | `ok` success, `stale` warning, `error` error; long-lived failure keeps the last successful clock | Word carries the state; the reason is in the `role="alert"` line below | Existing `success`/`warning`/`error` |
| Last-read clock | Compose mono text | — | — | `sync.at` null → `never`; ISO timestamp → local `Oct 29, 09:52`; tooltip carries the raw ISO value | `<time datetime>`; muted 11px text | Existing `muted-foreground`, `mono` |
| Last/next run clocks | Compose mono text | — | — | `lastRunAt`/`nextRunAt` null → `never`; locale time; tooltip raw value; tabular figures | Muted 11px text within the cadence group's reading order | Existing `muted-foreground`, `mono` |
| Cadence field | Reuse `Input` | `Input` | Covered by the primitive's stories | Integer 1–1440; saved value from the snapshot wins unless the field is being typed in; invalid sends nothing; field is 64px wide | Wrapping `<label>` gives the name `Every min`; number input with min/max/step and visible focus | `input` component, `control` type |
| Save cadence | Reuse `Button` secondary | `Button` | Covered by the primitive's stories | Disabled never; invalid cadence leaves the saved schedule intact and surfaces the alert below | Native button; secondary, never the filled primary | Existing button tokens |
| Hourly cap field | Reuse `Input` | `Input` | Covered by the primitive's stories | Empty → `unlimited`; integer 1–100; invalid sends nothing; saved value wins unless typing | Wrapping `<label>` names it `Per hour`; placeholder states unlimited | `input` component, `control` type |
| Open-issues cap field | Reuse `Input` | `Input` | Covered by the primitive's stories | Empty → `unlimited`; integer 1–100; same validation path as the hourly cap | Wrapping `<label>` names it `Open issues`; placeholder states unlimited | `input` component, `control` type |
| Save limits | Reuse `Button` secondary | `Button` | Covered by the primitive's stories | Commits both caps; either invalid value sends nothing and surfaces the alert | Native button; secondary | Existing button tokens |
| Settings band and groups | Compose page-scoped `.agent-settings` | — (documented in DESIGN.md) | — | Two `overline` groups; group items 10px apart, 6px rows; groups 24px apart and wrap as units; 6px 12px band padding | One outer `role="group"` named `Cadence and filing limits`; groups stay in DOM order after the run action | Existing spacing scale (4/6/10/24) and `overline` type |

## Component details

### PageHeader — footer slot
- **Decision:** modify the shared primitive with one optional snippet; no new component.
- **Why:** the header's frame, radius, and border belong to one surface; duplicating the frame in
  the page would create a second panel convention. The footer is generic: any operational page
  may need a secondary band for controls that configure its primary action.
- **API:** `footer?: Snippet`, rendered after the identity/action row inside `<header>`. The row
  moves into `.page-header__row`; stacked pages keep their existing geometry because the row owns
  the same flex rules the header had.
- **States:** footer present/absent; bar/stacked; flat. The footer is used with `bar` today.
- **Edge cases:** a footer with one group, two groups, or many wrapping groups; a long subtitle
  next to a fixed title; a 1024px workspace where the state/action cluster wraps.
- **Accessibility:** the footer is not part of the heading; controls keep their native semantics
  and DOM order (state → action → cadence → limits).
- **Tokens:** no new tokens. `border-subtle` hairline, 6px band padding, 12px horizontal padding,
  6/16px gaps.

### Agent settings band
- **Decision:** compose existing `Input`, `Button`, and labels in `AgentPage.svelte`; style with
  page-scoped classes and document the composition in DESIGN.md. No OpenUI page entry exists for
  page-scoped compositions.
- **Why:** the two groups are the only consumers of this exact band; the reusable pieces are the
  primitives. The band is content composition, not a new control API.
- **Data variety:** cadence 1–1440; limits 1–100 or empty; both caps empty; one empty and one set;
  a locale with wide time strings; timestamps `never`; a stopped agent whose next run is `never`;
  a running agent whose clocks are populated; a field mid-edit while the snapshot changes.
- **Edge cases:** a 1024px workspace where `Cadence` and `Filing limits` each take a row; a
  validation alert below the header while both groups stay visible; a disabled Start beside
  editable fields (settings remain usable while the run action is blocked).
- **Accessibility:** wrapping labels name every field and unit; save buttons name themselves; the
  group title is visible `overline` text, not a colour cue; focus order follows DOM order.
- **Tokens:** existing spacing (4, 6, 10, 12, 24), `overline` and `mono-small` type, `muted-
  foreground`, `foreground`, `border-subtle`.
