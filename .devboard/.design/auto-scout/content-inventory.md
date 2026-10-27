# Auto Scout — content inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Surface identity `Auto Scout` | Static page title | All | Orient the operator in Issues mode | yes | The page is reachable from a sidebar entry and needs its own heading. |
| C2 | Repository origin (`owner/repo`) | `scout.repoLabel` | 1, 4 | Confirm the worker targets the intended checkout | yes | A wrong origin is the first cause of an empty result. |
| C3 | Lifecycle (`stopped`, `idle`, `scanning`, `failed`) | `scout.lifecycle` | 1, 2 | Decide whether to start, wait, or stop | yes | The primary status of the surface. |
| C4 | Start/Stop action | `scout.canStart`, `scout.canStop`, `scout.start`, `scout.stop` | 1, 2 | Starts or stops the worker | yes | The primary action; exactly one is available. |
| C5 | GitHub-read state (`ok`, `error`, `stale`) | `scout.sync.state` | 4 | Separates a real empty result from a failed read | yes | Staleness changes the meaning of the table. |
| C6 | Last successful read | `scout.sync.at` | 4 | Shows how old the table is | yes | One timestamp beside the read state. |
| C7 | Last read error | `scout.sync.error` | 4 | Explains a failed or stale read | yes | The badge cannot carry the reason. |
| C8 | Pending issues count | `scout.count` | 1, 3 | Shows the open-issue pressure against the budget | yes | The page-level count, not repeated in the table header. |
| C9 | Worker process (`pid`, harness version) | `scout.snapshot.worker` | 1 | Confirms a worker is attached and which build runs it | yes | Diagnostic detail, secondary to lifecycle. |
| C10 | Next attempt | `scout.nextAttemptAt` | 1 | Tells the operator whether waiting is productive | yes | The only timing fact for an idle or failed worker. |
| C11 | Scan identity | `scout.snapshot.scan.scanId` / `newestScanId` | 1, 4 | Labels the activity currently shown | yes | Placed once, as the activity heading. |
| C12 | Limits: issues per rolling hour, open issues | `scout.limits` | 3 | Shows and edits the filing budget | yes | The editable values and their labels. |
| C13 | Limits explanation | Static copy | 3 | Explains the effective rule | yes | Kept as one short hint under the fields. |
| C14 | Limits validation error | `limitsError` | 3 | Explains why a save was refused | yes | Announced in the limits panel. |
| C15 | Filed issues table: title, link | `scout.issues[]` | 1, 4 | Opens the filed issue and verifies content | yes | The table's primary column. |
| C16 | Filed issues table: created, category, state, shipped version | `scout.issues[]` | 1, 4 | Judges age, origin, and whether the fix shipped | yes | The remaining table columns. |
| C17 | Filed issues count | `scout.issues.length` | 1, 3 | Confirms how many filings exist | yes | Panel header count. |
| C18 | Empty table state | `rows.length === 0` | 1, 4 | Distinguishes "nothing filed" from missing UI | yes | Kept with an explanatory second line. |
| C19 | Scan activity lines | `scout.activity` | 1, 4 | Shows commands and results of the newest scan | yes | The only audit trail on the page. |
| C20 | Activity empty state | `activity.length === 0` | 1, 4 | Distinguishes "not scanned" from a blank log | yes | Kept inside the log. |
| C21 | Notice (`Filed …`) | `scout.notice` | 1 | Confirms a successful filing pass | yes | Shown as a page banner. |
| C22 | Worker error | `scout.error` | 1, 4 | Explains a failed worker | yes | Shown as a page banner. |

## Conflicts and resolutions
- `scout.count` (open pending issues) vs the table row count (every filed issue):
  - Winner: both stay, with different labels and locations.
  - Why: the count drives the open-issue budget; the table also lists implemented
    issues. They answer different questions.
- `scout.sync.state` vs `scout.sync.error`:
  - Winner: state in the header badge, error in the banner.
  - Why: the badge answers "can I trust the table"; the banner carries the reason.

## Removed candidates
- `updatedAt`: no journey decides anything from it; last read already dates the data.
- `root`: the checkout path is an implementation detail and the origin names the target.
- `present`, `enabled`, `attached`: internal flags already summarized by lifecycle and the
  available action.
- Raw scan identifiers in the worker facts: duplicated by the activity heading.
- A second count of pending issues in the table header: the page count already states it.
- Review, approve, reject, or draft controls: deliberately absent from Auto Scout.
