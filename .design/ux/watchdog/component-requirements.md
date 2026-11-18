# Watchdog page — component requirements

The Watchdog is rendered by shared components, so the packet adds no page-level component. The
catalog (`openui.json`) offers `Button`, `IconButton`, `Input`, `PageHeader`, and `StageTrack`; the
agent page composes those with the `.panel`, `.badge`, `.mono`, and table rules documented in
`DESIGN.md`.

| Need | Decision | Existing entry | Data and state | Accessibility | Tokens |
|---|---|---|---|---|---|
| Page identity and health meta | **Reuse** `PageHeader` | `PageHeader` (OpenUI), `layout="bar"` | Title, descriptor description, peers badge, worker versions, forge badge and last read | Single `h1`, native `header`, meta words | existing |
| Cadence and filing limits | **Reuse** `AgentSettings` in the header footer | `AgentSettings.svelte` (DESIGN.md *Agent settings footer*) | Every 1–1440 (default 10), last and next run, per-hour and open-issue limits, save refusals | Labelled inputs, refusal beside its group, save feedback | existing |
| Lifecycle and activity | **Reuse** `AgentActivityBar` | `AgentActivityBar.svelte` (DESIGN.md *Agent activity bar*) | running/idle/stopped/failed dot; newest cycle line; expanded 180px log; Start/Stop control | `aria-expanded` toggle, `role="log"`, dot label | existing |
| Prompt disclosure | **Reuse** `AgentPromptSection` | `AgentPromptSection.svelte` (DESIGN.md *Agent prompt disclosure*) | Absent prompt message for this family | Native `details`/`summary` | existing |
| Filed issues table | **Reuse** `AgentIssuesTable` | `AgentIssuesTable.svelte` (DESIGN.md *Agent results empty state*, table rules) | 0, 1, 87, and 100+ rows; long generated titles; unknown state; absent version; stale and failed reads | `<th scope="col">`, sticky header, anchors with full titles, `<time datetime>` | existing |
| Panel frame | **Reuse** `.panel` | `DESIGN.md` panel and page-padding rules | Filed-issues panel only | `<section aria-label>` + `h2` | existing |
| State, action, and sync words | **Reuse** `.badge` + `statusTone` | `DESIGN.md` badge tones | `ok`/`stale`/`error`; `pending`/`implemented`/unknown | Word always present | existing |
| Empty and unread states | **Reuse** the shared empty stack | `DESIGN.md` *Agent results empty state* | Fresh empty, never read, failed read | Decorative mark `aria-hidden`, no focus target | existing |
| Always-visible glance | **Reuse** the status-bar indicator | `watchdog-indicator.svelte`, `StatusBar.svelte` (DESIGN.md *Status bar*) | Dot state, action and age, popover summary, reason, issue links | `aria-haspopup="dialog"`, `role="dialog"`, Escape closes | existing |

## Catalog and design-system impact

None. Every visual element is an `openui.json` entry or an existing `app.css` primitive composed by
the agent page; no token, DTCG value, OpenUI entry, Storybook story, or `DESIGN.md` component is
added. This packet therefore documents the shipped surface and requests no client change.

## Data variety the surface must survive

- Snapshots: none yet, a stopped family, a running family with one or several worker versions, a
  family gated for the project, and a snapshot carrying an error.
- Forge reads: `ok`, `stale` after 120 seconds, `error` with a reason, and a never-read family.
- Cycles: zero, one, and the retained 100; unknown action; no reason; no issue links; several issue
  links; a start or window value the client renders verbatim.
- Filed issues: zero, one, 87, and more rows than fit; titles from 40 to 200 characters; a category
  of up to 30 characters; `pending`, `implemented`, and unknown states; a shipped version present,
  absent (`—`), and longer than its 76px track.
- Settings: `unlimited` limits, a 10-minute default, 1 and 1440 boundaries, and a refused value per
  group.
- Viewports: 1440×900 and 1024×720, the shipped floor; the theme dark and light; both use tokens.
- Motion: the running dot's pulse stops under `prefers-reduced-motion`; nothing else animates.
