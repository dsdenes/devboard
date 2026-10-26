# Discover mode — UX brief

## Identity

- Route: `/` with no URL segment. Discover is a client-only mode of the single-page devboard
  shell; `localStorage` `devboard.layout.v1` restores it as the active mode.
- Title: the page title is the host repository path (`<title>` is set from
  `connection.projectPath`). Inside the mode the visible title is the project sheet.
- Auth/role: local developer or operator with access to the running dashboard. There is no
  account, role, or permission model in the interface; the server refuses nothing by user.
- Entry points: mode rail `Discover` (`data-testid="mode-discover"`, Alt+3), command palette
  `Switch to Discover`, a restored layout, or a Discover `data-command` from the palette.

## Goal

- Primary goal: let the developer decide whether the published Discover artifacts are current,
  trustworthy, and worth acting on, then take the one action that follows: run or re-run the
  crawl, read the project sheet, review a glossary term, or edit a policy skill.
- Success signal: after a run the Overview shows the new commit and discovery time, the sheet
  renders, and the five skills are present; on return the developer can state what the project
  is, how to run and test it, where its bounded contexts are, and which skill they changed.
- Secondary goals: stop an active run without losing the published artifacts; answer one queued
  crawl question; review warnings; start a manual remote crawl (source-checkout harness only).

## Arrival context

- What the user knows: they are working in a host checkout that devboard serves. They have seen
  Goal Mode and Flow Mode, or they were told to "discover the project" before implementing.
- What they carry in: a repository that may or may not have `.omp/discover/` and
  `.omp/skills/` artifacts; possibly a running or interrupted crawl; possibly saved skill edits.
- Prior page/state: any mode. Switching modes is a view change only and must not start work.
- Device/network assumptions: desktop browser, viewport at least 1024×720, local WebSocket; no
  mobile layout exists. The crawl itself may be slow and streams activity.
- Urgency: low. The user wants a quick orientation, not a wizard. One run at a time is shared
  with Goal and Flow work, so the run control must explain why it is unavailable.

## Relationship to other pages

- Upstream: Goal and Flow work. A Discover run is refused while either holds work, and a Goal or
  Flow command is refused while Discover runs.
- Downstream: implementation agents in this host read the five generated skills under
  `.omp/skills/`; the glossary and sheet are evidence for those agents and for the developer.
- Loops: after the repository changes, the sheet goes stale; re-running Discover refreshes it.
  Editing a skill loops back to its generated baseline through Restore.
- State left behind: published artifacts (`.omp/discover/`), live skills (`.omp/skills/`),
  saved skill edits, the selected Discover page, and the stored remote target on a source
  checkout. Reading or switching never writes.

## Journeys

### Journey 1 — first discovery (empty to published)

- Trigger: the developer opens Discover on a host with no published artifacts.
- Steps: read the empty explanation, click `Discover project`, watch the activity stream, wait
  for completion, scan the new sheet.
- Decision points: whether to run at all (the empty state must say what is written and what is
  not touched); whether to stop when the run takes long.
- Success: the sheet, glossary, and five skills are published; the Overview shows the project
  name, definition, commit, and discovery time.
- Failure routes: the run fails validation, writes outside staging, or collides with a non-
  Discover skill; the view shows one error and the previous artifacts stay readable. A server
  restart interrupts the run and says so.
- Recovery: re-run; nothing else is needed. The error names the reason.
- Exit: the developer opens Glossary, a skill, or another mode.

### Journey 2 — orientation scan (published sheet)

- Trigger: artifacts exist; the developer needs to know how to run, test, and navigate the repo.
- Steps: open Discover, read the header and freshness, read Commands, read Testing, scan the
  bounded contexts, optionally open Platform/Delivery facts, open a stack repository link.
- Decision points: which command is the test command; whether the sheet is stale; whether a
  section is `Not observed` and therefore must be checked by hand.
- Success: the developer can run and test the project from the sheet without another source.
- Failure routes: a missing or unreadable artifact renders an empty state; stale data is marked
  `stale`; an unknown field is labelled instead of guessed.
- Recovery: re-discover for stale or partially observed data.
- Exit: Goal or Flow mode, or a glossary/skill page.

### Journey 3 — stale re-discovery

- Trigger: the repository fingerprint changed; the header shows `stale`.
- Steps: open Discover, click `Re-discover`, watch the run, confirm the new commit and time.
- Decision points: whether the stale sheet is still good enough for the task at hand.
- Success: the badge disappears and the freshness line names the new commit.
- Failure routes: the run is disabled while other work is active; the title of the control
  names the reason. A failed run leaves the stale sheet in place and shows one error.
- Recovery: finish or stop the other work, then re-run.
- Exit: the refreshed sheet.

### Journey 4 — stop a run

- Trigger: an active run is taking too long or was started by mistake.
- Steps: find the active-run panel, click `Stop`.
- Decision points: whether to stop; the copy must say published artifacts are kept.
- Success: the panel disappears, the control returns to `Re-discover`, no replacement run starts.
- Failure routes: stopping closes the peer; if the run already finished, the view shows the
  published result instead.
- Exit: any page.

### Journey 5 — review a glossary term

- Trigger: the developer needs the project's word for a concept before writing code or a prompt.
- Steps: open Glossary, scan contexts, search or raise the minimum-use threshold, open a term,
  read definition, usage examples, labels, and related terms, go back.
- Decision points: which context owns the term; whether the term is significant enough to
  adopt; whether to use a related term instead.
- Success: the term's meaning and its real usage examples are visible without leaving the mode.
- Failure routes: a filtered-out term shows an empty result with a way back; a term that is no
  longer published shows a "no longer listed" message.
- Recovery: clear the search or the threshold; reopen from the glossary.
- Exit: another term, the glossary, or another mode.

### Journey 6 — change a skill and restore it

- Trigger: the generated policy is wrong for this host, or an earlier edit must be undone.
- Steps: open a skill, read its purpose and state, edit the text, save, observe the dirty marker
  clear, restore the generated version, observe the editor and disk agree.
- Decision points: which skill owns the rule; whether an edit is worth diverging from the
  generated baseline.
- Success: the file under `.omp/skills/` contains the edit; `edited` state shows in the page and
  the sidebar; Restore returns the generated text.
- Failure routes: a save is refused (error notification) and the draft stays dirty; a missing
  skill offers "Recreate generated version"; an unreadable skill shows the missing state.
- Recovery: retry, restore, or edit again.
- Exit: another skill or mode; the open skill survives a mode switch and reload.

### Journey 7 — answer a crawl question

- Trigger: the peer elicits one question during a run.
- Steps: read the message, choose a suggested option or type an answer, submit once.
- Success: the answer is sent once; the panel disappears.
- Failure routes: an empty answer is disabled; a stale id or second answer is refused with one
  error.
- Recovery: the run continues without the answer when the question is withdrawn. Empty values
  cannot be submitted.
- Exit: the active-run panel.

### Journey 8 — manual remote crawl (source checkout only)

- Trigger: a harness source checkout exposes a manual-testing target.
- Steps: paste `https://github.com/owner/repo`, submit, watch the clone, read the clone's sheet,
  clear the target.
- Success: the clone's artifacts render and clearing returns to this checkout with an empty field.
- Failure routes: an invalid URL, clone failure, or timeout is refused with one error, creates no
  clone, and keeps the previous target.
- Recovery: correct the URL or clear the target.
- Exit: the host target.

## Non-goals

- Editing the project sheet or the glossary: the sheet is read-only and glossary decisions are
  not exposed as confirm/reject controls in this interface revision.
- Starting a run on load, reconnect, mode switch, or page switch.
- Two concurrent Discover runs, or a Discover run concurrent with Goal or Flow work.
- Branch selection, private repositories, credentials, or multiple stored remote targets.
- A mobile layout below 1024×720.
- Editing `.omp/discover/` artifacts by hand from the browser.

## Assumptions

- The five skills are fixed by the Discover contract (`discover-testing-strategy`,
  `discover-naming-conventions`, `discover-coding-conventions`,
  `discover-architecture-boundaries`, `discover-glossary`).
- `freshness.project` is the repository path; the interface shows its last segment as the
  visible title and the full path in the sidebar and status bar.
- The shipped interface exposes no glossary confirm/reject decision control; the term page is a
  review surface. This brief treats that as the current contract, not as a redesign target.
- The remote target controls exist only where the server reports `remoteAvailable`.
