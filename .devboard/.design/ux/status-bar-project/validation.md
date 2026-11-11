# Validation — status bar project identity

- **Page:** Devboard shell footer (`/`), left group, project item.
- **Commit/branch:** worktree `.worktree/issue-1790`, branch `issue-1790` (cut from `origin/main`).
- **Command:** `/home/ds/devboard/.devboard/.tmp/bun run dev --port 5271 --strictPort` from
  `.worktree/issue-1790/.devboard`, proxying the live dashboard at `127.0.0.1:8080`.
- **Base URL:** `http://127.0.0.1:5271/` (changed revision); `http://127.0.0.1:8080/` for the
  pre-change baseline.
- **Playwright source:** OMP browser tool (Chromium, Playwright-backed).
- **Viewports:** 1440×900, 1024×768, plus the wireframe at 1440 and 390.
- **Journeys exercised:** confirm the attached repository; confirm the dashboard is live while
  reading; find the full path through the tooltip.
- **States exercised:** default connected; `No project` empty state (DOM substitution); 538px-long
  name; light theme; narrow viewport.
- **Dependent pages:** the footer is global, so the item renders on every mode. `.code-chip` itself
  was reused, not modified, so no other consumer of the chip changed.
- **Screenshots:** `before-status-group-1440.png`, `after-status-group-1440.png`,
  `after-status-bar-1440.png`, `after-status-bar-1024.png`, `after-status-group-light-1440.png`.
- **Console/network:** 0 console errors or warnings; 64 `200` and 136 `304` responses, 0 failed.

## Measured result

| Property | Before | After |
|---|---|---|
| Item classes | `status-item status-project` | `status-item status-project code-chip` |
| Height | 20px | 18px |
| Background / border | transparent, none | `#0d1117` (`background`) / 1px `#21262d` (`border-subtle`) |
| Padding | 0 5px | 0 6px |
| Icon-to-name gap | 2px | 4px |
| Name type | 12px mono, 400 | 11.5px mono, 400 |
| Vertical rules in the left group | 1 (`status-divider`) | 0 |

- Long name: chip caps at 320px, text ellipsizes (`scrollWidth` 538 vs 290 rendered), footer
  `scrollWidth` equals `clientWidth` at 1024px, so the bar neither scrolls nor overlaps.
- Empty state: `No project` renders in the same 18px chip (99px wide).
- Light theme: chip `background` white, `border-subtle` `#eaeef2`, text `#1f232c`, icon `#57606a`.
- Spacing audit: 18px height + 4px above and below inside the 26px bar; 6px inner padding, 4px
  icon gap, 320px status-item bound. Every value is a documented status-bar component value or an
  approved spacing step; no arbitrary value was introduced.
- Accessibility: the glyph stays `aria-hidden`; the item still carries the full path as its
  `title`; the name stays visible text, so nothing rests on colour or icon.
- Duplicate information: none added — the sidebar keeps the full path, the footer keeps the
  segment, the tooltip carries the path on demand.

## Checks run

- `bun run check` (svelte-check): 1735 files, 0 errors, 0 warnings.
- `bun run build`: 1128 modules transformed; `embed-client` refreshed
  `crates/devboard/assets`.
- `bun run test:client`: 457 pass, 0 fail, 1950 expectations across 69 files.

## Findings

- The wireframe at 390px first overlapped its inline region annotations; the narrow breakpoint now
  stacks the annotation on its own line. Re-verified: 390px and 1440px both report
  `scrollWidth == clientWidth`.
- No visual glitch found in the changed surface: no clipping, overlap, layout shift, or empty
  container; the former orphan divider is gone.

## Not run / blocked

- `DESIGN.md` lint (`design-md lint`) is unavailable (the UI/UX preflight reported `unverified`:
  no local `@google/design.md` install). Structure was checked by hand instead.
- `designmd` MCP research is unavailable in this session; the receipt is in
  `.design/research/2026-11-11-status-bar-project.md`.
- Storybook: the footer has no story before or after this change; the component was exercised in
  the running UI instead.

## Verdict

pass
