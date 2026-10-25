# Design system as used — devboard harness interface

Snapshot taken 2026-10-25 from the running dashboard at `http://127.0.0.1:8080/` (vitest-turbo host,
running 0.1.153) and from `.devboard/client/app.css` at commit `0a975f5`. Values are computed styles,
not declarations where the two could differ.

## Theme source the build honors

| Concern | Source |
|---|---|
| Tokens | `.devboard/client/app.css`, `:root` dark default and `:root[data-theme="light"]` |
| Tailwind | `@import "tailwindcss"` in the same file; utilities only in `ui/button.svelte` and layout helpers |
| Theme switch | `.devboard/client/lib/layout.svelte.ts`, persisted; `data-theme` on `<html>` |
| Fonts | system stacks, no webfont request |
| Minimum viewport | `.devboard/client/lib/viewport.svelte.ts`, `MINIMUM_VIEWPORT = { width: 1024, height: 720 }` |

## Scales as used

Colors, dark theme (light theme mirrors them and is not redesigned here):

| Token | Value | Role |
|---|---|---|
| `--background` | `#0d1117` | app canvas, code surfaces |
| `--surface` | `#161b22` | panels, sidebar, tab strip |
| `--surface-raised` | `#1c2128` | panel sub-headers |
| `--foreground` | `#e6edf3` | body and headings |
| `--muted-foreground` | `#8b949e` | labels, meta, secondary text |
| `--border` | `#30363d` | panel and section borders |
| `--border-subtle` | `#21262d` | row rules |
| `--border-strong` | `#6e7681` | control outlines, badges |
| `--primary` | `#1f6feb` | primary action, filled |
| `--primary-hover` | `#388bfd` | primary hover |
| `--accent` | `#58a6ff` | focus-adjacent accent, links |
| `--success` / `--badge-confirmed` | `#3fb950` | pass, resolved, observed |
| `--warning` / `--badge-stale` | `#d29922` | dirty, stale, pending |
| `--error` | `#ff7b72` | failure text |
| `--destructive` | `#da3633` | destructive action |
| `--accent-surface` / `--warning-surface` / `--error-surface` | `#16233a` / `#2b2411` / `#2b1513` | tinted message backgrounds |

Type as used:

| Role | Size / weight | Where |
|---|---|---|
| Page title | 20px / 650, -0.01em | `.discover-page__title` |
| Panel title | 12px / 600 | `.panel__title` |
| Body | 13px / 1.45 | `body` |
| Table cell / row | 12px, 5px 8px padding | `.table-wrap td` |
| Table head | 11px / 600, uppercase, 0.03em | `.table-wrap th` |
| Badge | 10px / 600, pill | `.badge` |
| Mono | 12px (11.5px in Discover tables) | `code`, `.mono` |

Spacing: 2, 4, 6, 8, 10, 12, 14, 16, 24, 28. Panel body 8px, panel header 30px, card grid gap 12px.
Radius: 3px (tabs, small controls), 4px (panels, buttons, inputs), 6px (chips), 999px (badges).
Shadow: none anywhere; depth is borders plus surface steps. Motion: 120ms ease for icons, 1207–1235
lines of `app.css` honor `prefers-reduced-motion`.

Layout: activity bar 44px; sidebar 300px default (Pane, 200–600px, resizable); workspace tab strip 34px;
status bar 26px; content padding 8px; page scroll column gap 8px (Discover overrides 14px).

## Component inventory

| Component | Path | Anatomy / states |
|---|---|---|
| Button | `client/lib/components/ui/button.svelte` | variants default/secondary/outline/ghost/destructive/link; sizes default 28px, sm 24px, icon 28px; disabled 45% opacity; focus ring 2px |
| IconButton | `client/lib/components/ui/icon-button.svelte` | square ghost icon button, aria-label required |
| Input | `client/lib/components/ui/input.svelte` | 28px control using `.textarea`-adjacent styling |
| Panel | `app.css` `.panel` | surface, 1px border, 4px radius, 30px header, 8px body, optional flush body |
| DataTable | `client/lib/components/DataTable.svelte` | TanStack; `compact` 27px rows, `wrap`, `full` (grows with page, no inner scroll), `rowAttrs`, `rowTestId`, `cellValue`, hover row, sticky-free |
| Badge | `app.css` `.badge` | tone pending/confirmed/success/stale/warning/error/accent; text always present |
| Sidebar | `client/lib/components/Sidebar.svelte` | groups with 10px uppercase titles, 24px items, right meta/badges, disclosures |
| Workspace tabs | `client/lib/components/WorkspaceTabs.svelte` | 34px strip, active tab on background |
| Terminal | `client/lib/components/Terminal.svelte` | xterm surface for activity logs |
| MonacoEditor | `client/lib/components/MonacoEditor.svelte` | full-height SKILL.md editor, dirty marker |
| PyramidChart | `client/lib/components/PyramidChart.svelte` | inline SVG bands, one per test level |
| DetailSplit | `client/lib/components/DetailSplit.svelte` | resizable main/detail panes |
| CommandPalette | `client/lib/components/CommandPalette.svelte` | Ctrl+K, aria dialog |

## Conventions

- GitHub-dark material: flat surfaces, hairline borders, no shadows, no gradients.
- Density first: 12–13px type, 24–30px controls, 27px table rows.
- Mono for paths, commands, identifiers, counts; system sans for prose.
- One primary action per surface, filled `--primary`; every other action outline or ghost.
- Uppercase micro-labels at 10–11px with 0.03–0.06em tracking for group and table heads.
- Badges are outline pills; tone carries color and the label always carries the meaning.
- Icons: `lucide-svelte`, 12–14px, `aria-hidden` beside a text label.
- Copy is factual, sentence case, no marketing adjectives; page headings name the object.
- Focus: global 2px `--ring` outline with 1px offset; no motion without a reduced-motion branch.

## Exceptions and deliberate decisions

- **390px mobile is not a supported composition.** Below 1024×720 the app replaces the workspace with a
  "Viewport too small" guard. The redesign targets 1280×900 and the supported minimum 1024×720; a 390
  capture proves the guard, not a layout.
- **Delivery section is hidden** (`HIDDEN_SECTIONS` in `client/lib/discover-format.ts`) because it repeats
  deployment, CI, and runtime facts.
- **Freshness panel and per-leaf evidence chips were removed** in `0a975f5` from operator feedback, but
  `discover.svelte` still exposes `freshness` and `stale`, and no current surface shows staleness. This
  redesign restores both as one quiet header meta line and per-section provenance.
- Table text is pinned to 12–14px and rows to ≤120px by `scripts/verify-interface.ts`; nested scrollers
  and Field/Value header tables are rejected by the same script.
