# Goal mode — content inventory

Every candidate the server or the client already holds. "Keep" answers one question: if the item
disappears, does the operator lose a decision or a journey step declared in `brief.md`?

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Saved goal text and draft with dirty state | `goal.goalText`, `goal.goalDraft`, `goal.goalDirty`, `goal.goalReady` | 1, 3 | Know whether the edited text is on disk; decide to save or discard | Keep | The document is the artifact; dirty state prevents silent loss |
| C2 | Goal creation running | `goal.creationActive` | 1, 13 | Know why the document is locked and where the run is | Keep | One of four exclusive run slots; disappears without it |
| C3 | Goal revision running | `goal.revisionActive` | 3, 13 | Know why revise is unavailable and that text may change | Keep | Same exclusive slot as C2 |
| C4 | Revision guidance | `goal.revisionRequest` | 3 | Direct the agent's revision | Keep | Without it revise is a blind reroll |
| C5 | Prepared skills with descriptions | `goal.skills` | 2, 4 | Know which policies the implementing agents read | Keep | The lifecycle start precondition; also the skills page body |
| C6 | Selected skill | `goal.selectedSkill` | 2 | Read one skill in the skills page | Keep | Navigation state for the skills page |
| C7 | Skill contradictions | `goal.contradictions` | 2 | Decide whether skills must be fixed before implementation | Keep | The only warning that two policies disagree |
| C8 | Skills preparation running | `goal.skillsPrepActive` | 2, 13 | Know why the goal is read-only and the start control is off | Keep | Exclusive slot |
| C9 | ADR title, file, document status, implementation state, summary | `goal.records` | 7, 11, 12 | Find the record, decide whether it is resolved, read the decision | Keep | The unit of the mode's work |
| C10 | Next record | `goal.next` | 7, 11, 12 | Start the right record without scanning | Keep | One record is the server's canonical next |
| C11 | Pending ADR count and per-set progress | derived from `goal.records` | 4, 11 | Know how much decision work is left | Keep | The progress signal for the whole mode; shown once per page family |
| C12 | Lifecycle stage | `goal.lifecycle.stage` | 4, 5, 9 | Decide whether to start, pause, answer, or stop | Keep | The primary state of the lifecycle |
| C13 | Lifecycle pass | `goal.lifecycle.pass` | 4, 5 | Know whether this is a retry pass | Keep | Cheap, and retries are otherwise indistinguishable |
| C14 | Lifecycle paused | `goal.lifecycle.paused` | 5 | Decide to resume; know the run is not progressing | Keep | Changes what editing is allowed |
| C15 | Work item being processed (epic or ADR) | `goal.lifecycle.work` | 4, 9 | Know the current unit and open its epic upstream | Keep | The only "what is it doing now" identity |
| C16 | Lifecycle active | `goal.lifecycleActive` | 4, 5, 9 | Show the right primary control | Keep | Drives start/stop selection |
| C17 | Manual run title, action, state | `goal.runTitle`, `goal.runAction`, `goal.runState` | 7, 9 | Know which record a manual run is resolving and whether it stopped | Keep | Manual runs are a declared path |
| C18 | Current action and activity history | `goal.activity` | 1–8, 13 | Follow progress, diagnose a stall | Keep | The only live narration; history cheap to fold |
| C19 | Queued question, options, recommended flag, free text | `goal.question`, `goal.draft` | 1, 3, 4, 6, 7 | Unblock the run | Keep | P0: the run waits on it |
| C20 | Lane list with label, kind, attempt, status | `goal.lanes` | 8, 4 | Find a lane, spot a retry or failure | Keep | Navigation for lane detail; status is the failing signal |
| C21 | Lane epic link | `lane.epic.url` | 8 | Open the upstream epic | Keep | The only external verification of an epic |
| C22 | Lane activity and lane question | `lane.activity`, `lane.question` | 8, 6 | Diagnose the lane; unblock it | Keep | Only the lane page shows the question text; the rail dot and the sidebar Run entry carry the cue |
| C23 | Open epic count | `goal.openEpics` | 4 | Confirm epic generation finished | Omit | The lifecycle stage and the epic lane already say this; a bare count invites a false precision |
| C24 | Running lane count | `goal.runningLanes` | 4, 7 | See that lanes are active before opening the list | Keep | Group-head summary of the lane navigation; one place only |
| C25 | Reset armed, running, and result | `goal.resetArmed`, `goal.resetting`, `goal.resetStatus` | 10, 13 | Confirm a destructive action; know the commit | Keep | Irreversible; needs an explicit second step and a report |
| C26 | Last connection error | `connection.lastError` | 13 | Decide to reconnect or retry | Keep | One error per connection attempt |
| C27 | Upgrade waiting | `connection.upgradePending` | 13 | Know a restart is coming after work ends | Keep | Explains a later restart |
| C28 | Connection state | `connection.state` | all | Trust the displayed state | Keep | Status bar only |
| C29 | Project path | `connection.projectPath` | all | Know which checkout this is | Keep | Status bar only; the sidebar no longer repeats it |
| C30 | Current mode | `layout.mode` | all | Locate yourself | Keep | Mode rail selection |
| C31 | Running and installed versions | `connection.version` | 13 | Know whether a reload is available | Keep | Status bar only |
| C32 | Theme preference | `layout.theme` | all | Read comfortably; persist | Keep | Rail footer toggle |
| C33 | Notification history | `notifications` | 13 | Recover a past message | Keep | Rail footer indicator |
| C34 | Command palette | `commands` | all | Reach any action by name | Keep | Rail footer affordance; keyboard shortcut stays |
| C35 | Unimplemented "reference" hints | none | — | — | Omit | Nothing in the contract supplies them |
| C36 | "No tab is open" placeholder | `tab === null` | all | Recover from a closed page | Keep | A fallback only; real navigation leads with pages |
| C37 | Sidebar ADR list with per-record status | `goal.records` | 11, 12 | Jump to a record from anywhere | Keep | Navigation, compact: progress, next record, pending records, all-records entry |
| C38 | Sidebar skills list inside a disclosure | `goal.skills` | 2 | Jump to the skills page with one skill selected | Keep | One disclosure, never a second section |
| C39 | Reset keep/delete rule text | constant | 10 | Decide whether the loss is acceptable | Keep | Shown only while armed, next to the confirm control |
| C40 | Goal creation and revision results | `goal.goalText` after stop | 1, 3 | Continue from the produced text | Keep | Merged into C1; no separate "result" surface |

## Conflicts resolved

- **Pending count.** Available three ways: `goal.pendingCount`, the ADR list length, and the status
  bar string. The page owns the actionable number; the status bar keeps the ambient one. No third.
- **Record identity.** `record.title` appears in the ADR row, the record page, the sidebar entry,
  and the lane label. Rows and navigation keep it; the record page keeps it in its header only.
- **Lifecycle work.** The ADR title appears in the stage track and again as the lane label. The
  stage track is the canonical "now"; a lane page repeats it only because it is that lane's name.
- **Run state.** `goal.running` and `goal.runState` describe the same run. One derived label;
  `runState === "stopped"` is the only extra fact and is shown once as a notice.
- **Skills.** `goal.skills.length` is in the sidebar and the skills header. The sidebar keeps the
  count for navigation; the page header states readiness and contradictions, not the count again.
- **Project path.** Shown in the status bar and previously in the sidebar title block. The status bar
  wins; the sidebar states mode and lifecycle context instead.
