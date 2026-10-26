# designmd.ai research — 2026-10-26

- **Task:** Bootstrap the `ui-ux` prerequisites for the devboard harness interface: a normative
  `DESIGN.md`, generated DTCG, an OpenUI catalog of the shipped primitives, and a Storybook
  specimen. The interface is a dense, dark-first operator console for repository goals, ADR
  records, Flow sessions, and Discover artifacts, used by developers on a desktop at 1024×720 or
  larger.
- **Tools and arguments:**
  - `mcp__designmd_search_design_kits` with
    `{"query":"dense dark IDE-style developer dashboard, repository workflow console, monospace technical admin interface, GitHub-dark palette","limit":10}`
    → `[]`.
  - `mcp__designmd_search_design_kits` with `{"query":"developer tools dashboard dark"}` → `[]`.
  - `mcp__designmd_list_tags` → 50 tags; `devtools` (37), `dark` (229), `dashboard` (140),
    `dense` (9).
  - `mcp__designmd_list_popular_kits` with `{"tag":"devtools"}` → 10 kits.
  - `mcp__designmd_get_design_kit` with `{"identifier":"chef/octo-code"}`.
  - `mcp__designmd_get_design_kit` with `{"identifier":"chef/violet-issue"}`.
- **Candidates (designmd.ai URLs):**
  - Octo Code — https://designmd.ai/chef/octo-code — dark-first developer system whose preview
    palette is the same surface family as this interface (`#0d1117`, `#161b22`, `#388bfd`,
    `#8b949e`).
  - Violet Issue — https://designmd.ai/chef/violet-issue — dense, keyboard-driven issue tracker;
    compact 28px controls, layered surfaces, no shadows.
  - DocuForge — https://designmd.ai/chef/docuforge — light documentation layout; not a match.
  - TerminalUI — https://designmd.ai/chef/terminalui-design-system — monospace-only terminal
    aesthetic; too extreme for a mixed prose/table console.
- **Adopted:** principles only, no literal values.
  - Dark-first palette with depth expressed as surface steps (`background` → `surface` →
    `surface-raised`) and hairline borders, never shadows.
  - High information density: compact control heights, 10–13px type, monospace for paths,
    identifiers, and counts.
  - Flat, instant interactions; short transitions and a reduced-motion branch.
  - Every color carries a role; accent and primary are reserved for interaction, never large
    fills.
- **Rejected:**
  - Octo Code's literal palette (`#2f81f7` primary, `#238636` merge green, `#f85149` error) and
    Inter/JetBrains Mono webfonts. This interface already ships `#1f6feb` primary, `#3fb950`
    success, `#ff7b72` error, and system font stacks with no webfont request. Replacing them
    would change the product's visual identity without evidence.
  - Octo Code's 6px/12px radius scale and 32px controls; the existing UI uses 3/4/6px radii and
    28px controls.
  - Violet Issue's violet accent, 6/8/12px radii, and 36px rows. Only its density and layering
    argument applies.
- **Why:** the repository's own stylesheet is the only legitimate source of truth for token
  values. The kits confirm the direction (dense GitHub-dark devtool) and supply no value that
  overrides `.devboard/client/app.css`, so all tokens are derived from the shipped UI.
- **Effect on DESIGN.md / tokens / components:** `DESIGN.md` documents the measured palette,
  type scale, spacing scale, radii, and the three shipped primitives (`Button`, `IconButton`,
  `Input`) from `app.css` and `client/lib/components/ui/`. No kit value entered the tokens. The
  DTCG file is generated from `DESIGN.md`. The OpenUI catalog lists only components that exist.
