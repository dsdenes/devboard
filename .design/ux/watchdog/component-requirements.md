# Watchdog page — component requirements

| Need | Decision | OpenUI entry | Storybook story | Data/state requirements | Accessibility | Token needs |
|---|---|---|---|---|---|---|
| Page identity and sync meta | Reuse | `PageHeader` | `page-header.stories.ts` | Title; no eyebrow; subtitle; meta row with badge and mono time; no actions | Native `<header>`, single `h1`, meta is inline text | None |
| Panels for newest cycle, filed issues, history | Reuse | `.panel` (documented in DESIGN.md; not an OpenUI primitive) | — | 30px header; flush body for tables/lists; capped scrolling body | `<section>` with `aria-label`, `h2` per panel | None |
| Sync, action, and issue-state words | Reuse | `.badge` with `data-tone` | — | `ok`→success, `stale`→stale, `error`→error; `filed`→success; `commented`→accent; `failed`→error; `pending`→pending; `implemented`→success; `duplicate`/`none`/unknown→neutral | Word always present; color is never the only signal | None |
| Newest-cycle stat rail | Compose | `.watchdog-facts` grid + `.mono` value | — | 3 stats; zero, one, or many digits; `never` for no cycle; warning pending while > 0 | `dl`/`dt`/`dd` keep label–value pairs | Spacing scale, typography only |
| Reason line | Compose | `.watchdog-reason` | — | Optional; long server messages wrap; omitted when absent | Plain text, `muted-foreground`, no alert role (the badge owns state) | None |
| Filed issues table | Compose | Local `.watchdog-table` using table rules in DESIGN.md | — | 0, 1, many rows; long lines; `—` version; unknown state; sticky header | `<th scope="col">`, native anchors, ellipsis with tooltip | None |
| Cycle history list | Compose | Local `.watchdog-cycle` grid | — | 0–100 rows; 1–many issue links per row; unknown action; long URLs shortened to `#n` | `<ol>` list semantics, native anchors, `aria-label` per row | None |
| Empty states | Compose | `.watchdog-empty` | — | No cycle, no filed issue | Plain text, no role, not focusable | None |

No OpenUI entry, Storybook story, or token changes are required: every need is carried by the
existing `PageHeader`, `.panel`, `.badge`, `.mono`, and the documented table rules. The page's
local classes are a single-consumer composition, matching the Issues queue, agent row, and
Discover page frames.

## Data variety the page must survive

- Empty snapshot: no cycle, no ledger entry, no GitHub success → `never`, `none`, empty lines.
- One and many: 1 cycle vs 100 cycles; 0, 1, 13 filed issues; 0–3 issue links per cycle row.
- Long values: a 300-character finding line (ellipsis), a rate-limit error paragraph (wraps in the
  alert), a version tag up to 40 characters (mono cell may ellipsize).
- Missing/null: `cycle: null`, missing `reason`, `state: null`, `version: null`.
- Narrow/wide: 1024px stacked and 1726px two-column workspace panes; no horizontal scroll.
- Themes: dark normative and the light mirror; both use tokens, no literal colors.
- Reduced motion: no transition or animation is added.
- Localization: timestamps use `toLocaleString`; labels stay short enough for one line.
