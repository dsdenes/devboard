# Discover skill header — UX brief

## Identity

- Route: `/`, Discover mode, skill page (`data-tab` = `testing-strategy`, `naming-conventions`,
  `coding-conventions`, `architecture-boundaries`, or `glossary`).
- Title: the page header names the selected skill; the editor panel header names its file,
  `<skill>/SKILL.md`.
- Auth/role: local developer or operator. No account or role model exists in the interface.
- Entry points: Discover sidebar skill rows, the command palette (`discover.tab.<slug>`), or a
  restored layout whose active Discover tab is a skill.

## Goal

- Primary goal: edit one generated policy skill, decide whether the draft differs from the live
  file, and save or discard that draft without leaving the editor.
- Success signal: the header states the file and the draft state, Save enables only for an
  unsaved draft, and a click leaves the editor and disk byte-identical.
- Secondary goals: restore the generated baseline after an edit; recreate a live skill file that
  was deleted outside the interface.

## Arrival context

- What the user knows: the skill page is one full-height Markdown editor for a generated policy.
  The sidebar already marks a skill as edited or missing.
- What they carry in: a draft loaded from the live file, or a draft preserved across a mode
  switch; possibly a deleted live file or a save failure.
- Prior page/state: another Discover page, another skill, or another mode.
- Device/network assumptions: desktop, at least 1024×720, local WebSocket; no mobile layout.
- Urgency: low. The header is read before typing and checked after typing.

## Relationship to other pages

- Upstream: a Discover run publishes the generated baseline and the live skill.
- Downstream: implementation agents in the host load the live skill from `.omp/skills/`.
- Loops: edit → Save → clean; edit → Discard edits → generated baseline; missing live file →
  Recreate generated version.
- State left behind: the saved live skill, the generated baseline, and the draft state.

## Journeys

### Journey 1 — verify the open file

- Trigger: the developer opens a skill to read or edit it.
- Steps: read the page title, then the relative path and draft state in the editor header.
- Decision points: whether this is the policy that owns the rule; whether the draft is already
  saved.
- Success: the path and the state are readable in one glance and the Save control is quiet while
  there is nothing to save.
- Failure routes: a deleted live file is stated as `Live file missing`, not as a clean draft.
- Recovery: restore the generated version.
- Exit: start editing or leave the page.

### Journey 2 — save an edit

- Trigger: the draft differs from the live file.
- Steps: edit, see the state change to `Unsaved changes`, click Save, see it return to clean.
- Decision points: whether to save or discard.
- Success: Save becomes the one filled primary while the draft is dirty; after the save it is
  quiet and disabled again.
- Failure routes: a refused save keeps the draft dirty and reports one error notice.
- Recovery: correct the text and retry, or discard the draft.
- Exit: the clean header.

### Journey 3 — discard an edit

- Trigger: the draft is wrong or unwanted.
- Steps: click `Discard edits`, observe the generated text return and the dirty state clear.
- Decision points: whether the generated baseline is preferable.
- Success: the outline control is visible whenever the live text differs from the baseline.
- Failure routes: a refused restore keeps the draft and reports one error.
- Recovery: retry or save the draft instead.
- Exit: the clean header.

### Journey 4 — recreate a deleted skill

- Trigger: the live file was removed outside the interface.
- Steps: open the skill, read `Live file missing`, click `Recreate generated version`.
- Decision points: whether to recreate or leave the file absent.
- Success: Recreate is the filled primary because Save cannot succeed; the file and editor agree
  afterwards.
- Failure routes: a refused recreate keeps the missing state and reports one error.
- Recovery: retry.
- Exit: the clean header.

## Non-goals

- A rendered Markdown preview or split pane.
- Editing the generated baseline in place.
- A page-level state badge or purpose line; the sidebar already owns the edited/missing flag.
- Mobile behavior below 1024×720.

## Assumptions

- The five skill names are fixed by the Discover contract.
- The page title is distinct from the file path and stays above the editor panel.
- The draft can be dirty while the live file is missing; Save stays disabled until recreation.
