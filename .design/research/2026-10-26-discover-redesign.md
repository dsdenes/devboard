# designmd.ai research

- Task: redesign the Discover mode (all pages and states) and the common mode menu of the devboard
  harness interface. The change is structural: a labeled mode rail, a mode-aware sidebar header,
  a shared page header, and reorganized Discover pages. The visual identity stays the shipped
  GitHub-dark operator console; no palette or type token is replaced.
- Tools and arguments:
  - `mcp__designmd_search_design_kits` with
    `{"query":"dense keyboard-first developer operator console with labeled mode navigation, evidence tables, and plain document review panes, dark IDE aesthetic","limit":10}`
    → `[]`.
  - `mcp__designmd_search_design_kits` with `{"query":"developer dashboard navigation sidebar dark"}`
    → `[]`.
  - `mcp__designmd_list_popular_kits` with `{"tag":"devtools"}` → 10 kits.
  - `mcp__designmd_get_design_kit` with `{"identifier":"chef/violet-issue"}`.
  - `mcp__designmd_get_design_kit` with `{"identifier":"chef/octo-code"}`.
- Candidates (designmd.ai URLs):
  - Violet Issue — https://designmd.ai/chef/violet-issue — dense, keyboard-driven issue tracker;
    28px compact controls, layered dark surfaces, flat rows, no card shadows.
  - Octo Code — https://designmd.ai/chef/octo-code — dark-first developer system in the same
    surface family as this interface (`#0d1117`, `#161b22`, `#8b949e`), mono for code and counts.
  - DocuForge — https://designmd.ai/chef/docuforge — structured sidebar navigation for long
    reference pages; light and documentation-oriented.
  - TerminalUI — https://designmd.ai/chef/terminalui-design-system — monospace-only terminal
    aesthetic; too extreme for a mixed prose/table console.
- Adopted (principles only, no literal values):
  - Navigation must name its destinations: Violet Issue and Octo Code both treat navigation as
    text-first and keep shortcut hints beside the label. This supports widening the mode rail and
    adding a visible label per mode.
  - Active navigation needs more than a color change: a left indicator plus a filled surface
    (both kits), and the label must remain visible in the active state.
  - Compact rows and compact controls carry the density; grouping is by task (Violet Issue's
    list/board split), not by data source.
  - Section headings use an uppercase micro-label; identifiers, paths, and counts use mono
    (Octo Code). The shipped `overline` and `mono-small` tokens already encode this.
  - No shadows on functional surfaces; depth is a surface step plus a hairline border.
- Rejected:
  - Violet Issue's violet accent (`#5E6AD2`) and 6px/8px/12px radii. The shipped interface uses
    `#58a6ff` accent, 3/4/6px radii, and 28px controls; adopting these would change the product
    identity without evidence.
  - Octo Code's and Violet Issue's Inter and JetBrains Mono webfonts. The interface requests no
    webfont and uses system stacks; keep that.
  - A collapsible icon-only rail (Violet Issue collapses 220px to 48px). The user asked for the
    common menu to be redesigned, and a collapse control would restore the icon-only failure mode
    plus add a second state to test. The rail stays fixed and labeled.
  - Command palette as primary navigation. Both kits recommend it; devboard already ships
    Ctrl+K and Alt+1/2/3, but mode switching must remain visible for operators who do not know
    the palette exists.
  - Card shadows, gradient accents, and large accent fills.
- Why: the redesign is an information-structure and navigation change inside an established
  visual system. Borrowing literal palettes, fonts, or radii would be a rebrand, not a redesign.
- Effect on DESIGN.md / tokens / components:
  - `DESIGN.md`: the `## Layout` shell dimensions change (mode rail 44px → 64px, sidebar header
    34px → 44px), and the `## Components` section documents the labeled mode rail and the page
    header slots. The spacing scale is unchanged, and the shipped Discover values that were
    outside the scale (18px, 22px, 10.5px, 11.5px, 12.5px) are corrected to 24/16/12/11/13.
  - `design/tokens.json`: unchanged. No color, typography, spacing, radius, or component token
    value changes; the file is regenerated and diffed to prove it.
  - `openui.json`: unchanged. The three catalog primitives keep their props; the mode rail is
    shell chrome, not a reusable primitive.
  - `stories/design-system.stories.ts`: adds the labeled mode rail and page header specimens.
