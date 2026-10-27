# Issues — Agents fleet page structure

## Region

The page keeps the existing frame: the Issues workspace scroller, a page header, and the fleet
body. No sidebar, rail, status bar, or page-level container moves.

```
section.issues-agents-page (scrolls)
├─ PageHeader                                    (C13)
│  ├─ eyebrow "Issues" · h1 "Agents" · repo
│  └─ meta: "N running" accent badge · "N need an answer" warning badge   (C11/C12)
├─ empty panel (only with zero agents)            (C14)
└─ div.issues-agent-grid (auto-fill, 12px gap, stretch)
   └─ article.issues-agent                        (one card per agent, issue order)
      ├─ header.issues-agent__head
      │  ├─ a.issues-agent__issue  "#225" mono accent link               (C1/C9, P0)
      │  └─ Button "Focus" outline, right-aligned                        (C10, P1)
      ├─ h2.issues-agent__title  2-line reserved slot, ellipsis           (C2, P0)
      ├─ p.issues-agent__meta  "5m 12s elapsed · started 18:13:57"       (C6/C7, P1/P2)
      ├─ div.issues-agent__activity                                      (C8, P1)
      │  ├─ p overline "Latest activity"
      │  └─ pre.issues-activity (fills the remaining card body)
      └─ IssuesAgentQuestion (warning surface, only while waiting)       (C5, P0)
```

## Order and hierarchy

- Identity first: the mono issue number is the landmark, the title is the content. Both are in
  the first third of the card, above any scrolling log.
- The action lives in the card head, at the same height across the row so the operator can move
  between cards without hunting.
- The live evidence follows the identity: elapsed/start time, then the newest activity. Activity
  is the only flexible region and fills a stretched card; it never pushes the question or the
  head around.
- The question block is last because it grows with its options. It is the only warning-tinted
  area, and it owns the answer.
- Cards keep issue order and are never re-sorted by attention. The header count plus the warning
  surface make a blocked card visible during a left-to-right scan.
- Grid: `repeat(auto-fill, minmax(360px, 1fr))` with 12px gaps. Rows are `max-content` and items
  stretch, so every card in a row has the same height and activity absorbs the slack.
- Cards are 1px `border`, 4px radius, `surface` fill, 10px padding, 8px internal rhythm. No
  shadow, gradient, or large fill.

## States

| State | Rendering |
|---|---|
| Default card | Issue link, title, elapsed/start, labeled activity, `Focus` |
| Long title | Exactly two lines with ellipsis; full title in the `title` attribute and heading |
| Short title | The slot reserves two lines so the meta line aligns with the other cards |
| Waiting on a question | `warning` card border and the warning-surface question block; no extra pill |
| Question answered | Question block disappears on the next state push; card border returns to `border` |
| No activity | `No activity yet.` from the shared log component, inside the labeled region |
| Many agents | The page scrolls; cards keep their anatomy and the header scrolls away with them |
| No agents | Empty panel: `No agents running`, one sentence, `Open Overview` |
| Malformed `startedAt` | The raw string renders in the elapsed and start slots; no invalid date |
| Narrow card (360px) | Title, meta, and question wrap; the head keeps the link and `Focus` on one row |
| Wide viewport (2101px) | Four cards per row; no horizontal overflow, no card wider than 1fr |

## Responsive priority

- The supported floor is 1024×720. The grid auto-fills from 360px: one column at the 1024 floor,
  two at 1440, four at 2101.
- The title absorbs horizontal change first; the issue link and `Focus` never shrink.
- The meta line wraps only after the title; activity fills vertical space instead of growing a
  card beyond its row.

## Accessibility

- Each card is a labeled `article` (`aria-labelledby` → its heading).
- The issue number is a real link with an accessible name naming the issue and title; it opens a
  new tab. `Focus` is a native button; the answer input and submit are native controls.
- The warning surface always contains the question text, so colour is never the only signal.
- Focus follows issue order: issue link, `Focus`, answer option, answer field, submit. The global
  2px `ring` and 1px offset stay visible.
- The activity block is a `<pre>` with real text; it is not the only source of the issue identity.
- Header counts use words (`3 running`, `3 need an answer`), never colour alone.

## Out of scope

The sidebar, the page header copy and counts, the empty-state panel, the Overview output pane, and
the agent focus page keep their current structure. No token, OpenUI entry, or Storybook story
changes.
