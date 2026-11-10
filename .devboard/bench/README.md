# Harness benchmark report

`report.md` is the committed benchmark. Reproduce it from the current tree:

```bash
bash .devboard/bench/run.sh --rust target/debug/devboard --out bench/report.md
```

The baseline is named in the generated report: the archived TypeScript baseline at
`eb4d4e22`, whose measurements the committed two-column report carries. The command never needs
`contract/serve-typescript.ts`, the retired TypeScript server, or a second checkout. Passing
`--typescript "<command>"` measures a live baseline beside Rust when an archived tree is
available; otherwise the report is the Rust column.

The benchmark measures one REST read per iteration and names the HTTP method and path it used.

## Idle CPU and read bytes

`devboard bench cpu` measures what one dashboard and its family workers spend while idle:

```bash
cd .devboard
cargo run -p devboard -- bench cpu --scenario runs-view --json
cargo run -p devboard -- bench cpu --scenario all-workers --json
```

Each run builds a scratch host under `.test-tmp`, starts a scratch `devboard serve --port 0`,
and prints `cpuPercent` and `readBytesPerSecond` from `/proc/<pid>/io` and `/proc/<pid>/stat`
over `--seconds` (30 by default). `runs-view` measures one dashboard serving the shipped page:
that page opens no `/agent-runs` request and no per-run output socket, so the scenario opens
neither, and the 201 seeded run records are only the state the dashboard holds. `all-workers`
starts every family worker live with an hour until its next due sync. The top-level figures are
the dashboard's for `runs-view` and the summed workers' for `all-workers`; `dashboard` and
`workers` carry the per-process detail. Nothing is written to the operator's state directory and
every process the run starts is ended before it returns.

## Forge load test

`gitea-load.sh` measures the live forge and the dashboard's read path under concurrent load:

```bash
bash .devboard/bench/gitea-load.sh --clients 64 --duration 600 \
  --out .devboard/.tmp/gitea-maintenance/load.json
```

Every client reads the project's issue list and the dashboard's `/issues` until the deadline, and
the writers also create an issue in a disposable `devboard-load` repository, comment on it, and
close it. The repository is deleted before the report is written and on every exit path, so the
forge keeps no trace of the run. `GITEA_TOKEN` is required; `DEVBOARD_GITEA_URL` names the forge
when `--gitea` is absent, and `--db`, `GITEA_DB`, or the running server's own config name the
database whose size the report carries.

The report is one JSON object: `clients`, `durationS`, `gitea.p50Ms`, `gitea.p95Ms`,
`dashboard.p50Ms`, `dashboard.p95Ms`, `lockErrors`, `httpErrors`, `writesFailed`, `dbBytesAfter`.
The run exits 0 only when the gitea p95 is at most 100 ms, the dashboard p95 at most 500 ms, no
request failed, no request met a lock error, and the database stayed at or below 1 GiB.

`scripts/gitea-db-maintenance.sh --cap-bytes <n> [--db <path>]` enforces that last bound: it holds
one Gitea SQLite database inside the cap with WAL journaling and incremental auto-vacuum, prints
`dbBytes`, `pageSize`, `pageCount`, `freePages`, `journalMode` and `autoVacuum`, and exits 0 only
when the database is inside the cap with WAL and incremental auto-vacuum in force.
