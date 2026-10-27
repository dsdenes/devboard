# Goal mode — significance inventory

`score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)`

Bands: P0 80–100, P1 60–79, P2 40–59, P3 20–39, drop below 20.

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C19 | Queued question, options, free text | 5 | 5 | 5 | 5 | 4 | 98 | P0 | A focused "waiting on you" region, first on the implementation page and on the lane page |
| C1 | Goal text, draft, dirty, ready | 5 | 5 | 5 | 5 | 3 | 96 | P0 | Goal document page, editor owns the page height |
| C9 | ADR fields and summary | 5 | 5 | 5 | 5 | 3 | 96 | P0 | ADR list row + record page |
| C12 | Lifecycle stage | 5 | 5 | 5 | 5 | 3 | 96 | P0 | Stage track in the implementation page header |
| C15 | Current work item | 5 | 5 | 5 | 5 | 2 | 94 | P0 | Stage track detail, linked when it is an epic |
| C10 | Next record | 5 | 5 | 4 | 5 | 2 | 91 | P0 | Progress line on ADRs, "Next" marker in rows, sidebar next entry |
| C16 | Lifecycle active | 5 | 5 | 5 | 3 | 2 | 88 | P0 | Primary control selection in the implementation header |
| C20 | Lane list with status and attempt | 4 | 4 | 4 | 5 | 3 | 81 | P0 | Sidebar "Lanes" group with status badges; one click to the lane |
| C11 | Pending count and set progress | 4 | 4 | 5 | 4 | 2 | 79 | P1 | One progress line on the ADRs page, one line on the implementation page, sidebar count; the status bar keeps the ambient word |
| C18 | Current action and history | 4 | 4 | 5 | 4 | 2 | 79 | P1 | Activity panel on the implementation and lane pages |
| C14 | Lifecycle paused | 4 | 5 | 2 | 5 | 2 | 78 | P1 | Stage track state + Resume control |
| C22 | Lane activity and lane question | 4 | 5 | 2 | 5 | 2 | 78 | P1 | Lane page |
| C5 | Prepared skills | 4 | 4 | 3 | 5 | 2 | 76 | P1 | Skills page body + sidebar disclosure |
| C17 | Manual run title, action, state | 4 | 4 | 3 | 5 | 2 | 76 | P1 | "Now" summary on the implementation page |
| C7 | Skill contradictions | 4 | 4 | 1 | 5 | 4 | 74 | P1 | Skills page warning list, counted in the sidebar meta |
| C3 | Revision running | 4 | 4 | 2 | 4 | 2 | 70 | P1 | Document header operation state + notice |
| C4 | Revision guidance | 4 | 4 | 2 | 4 | 2 | 70 | P1 | Document footer field |
| C25 | Reset armed, running, result | 2 | 5 | 1 | 5 | 5 | 67 | P1 | Danger zone at the end of the implementation page |
| C26 | Last connection error | 3 | 4 | 2 | 4 | 3 | 65 | P1 | Notice stack top |
| C2 | Goal creation running | 3 | 4 | 2 | 4 | 2 | 63 | P1 | Notice + document header operation state |
| C8 | Skills preparation running | 3 | 4 | 2 | 4 | 2 | 63 | P1 | Notice + skills header operation state |
| C37 | Sidebar ADR navigation | 3 | 4 | 5 | 1 | 2 | 63 | P1 | Compact group: progress, next record, pending records, all-records entry |
| C13 | Lifecycle pass | 3 | 3 | 2 | 4 | 1 | 56 | P2 | Secondary text in the stage track |
| C21 | Lane epic link | 3 | 3 | 1 | 5 | 1 | 56 | P2 | Lane identity row |
| C34 | Command palette | 3 | 3 | 4 | 2 | 1 | 56 | P2 | Rail footer affordance, `Ctrl+K` |
| C28 | Connection state | 2 | 3 | 5 | 1 | 2 | 51 | P2 | Status bar dot and word |
| C30 | Current mode | 3 | 2 | 5 | 1 | 1 | 51 | P2 | Rail selection |
| C38 | Sidebar skills disclosure | 3 | 3 | 3 | 1 | 1 | 50 | P2 | One disclosure under the Skills entry |
| C39 | Reset keep/delete rule | 1 | 5 | 1 | 1 | 5 | 48 | P2 | Shown only while the reset is armed |
| C29 | Project path | 2 | 2 | 5 | 2 | 1 | 47 | P2 | Status bar, plus the sidebar identity the shell contract requires |
| C32 | Theme preference | 2 | 2 | 5 | 1 | 1 | 47 | P2 | Rail footer toggle |
| C33 | Notification history | 2 | 2 | 4 | 2 | 2 | 46 | P2 | Rail footer indicator |
| C24 | Running lane count | 2 | 2 | 4 | 1 | 1 | 41 | P2 | Lanes group head and the ambient status bar |
| C27 | Upgrade waiting | 1 | 2 | 1 | 4 | 3 | 38 | P3 | Keep as a notice only when true; it explains a later restart |
| C31 | Running/installed versions | 1 | 3 | 1 | 3 | 2 | 38 | P3 | Status bar only |
| C6 | Selected skill | 2 | 2 | 2 | 2 | 1 | 38 | P3 | Interaction state, not a displayed fact |
| C36 | "No tab is open" fallback | 1 | 1 | 1 | 1 | 1 | 20 | P3 | Keep as a structural fallback with a link back to the implementation page |

## After scoring

- C23 (open epic count) was scored 34 and dropped. The stage track and the epic lane answer the
  same question with a real object; a bare count adds a number to reconcile.
- C6 is kept in the store but never rendered as its own fact; the skills page row shows selection
  through `aria-current`, which is an affordance, not information.
- C27, C31, C36 survive below P2 only because their absence creates a wrong impression (a restart
  with no warning, a version gap with no control, a dead page with no way back). They are ambient
  or fallback surfaces, not page content.
- Deduplication after scoring: the lifecycle work title appears once on the implementation page and
  once as the lane page's own name. The pending count appears once per visible page (implementation
  or ADRs), because the loop's next action depends on it; the status bar keeps the ambient word.
  The project path appears in the status bar and in the sidebar identity, where the shell contract
  requires the repository name; the versions appear only in the status bar.
