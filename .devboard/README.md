# Devboard harness

The harness is the Rust dashboard, its workers, and the browser client. Its
operating contract lives in `AGENTS.md` and the project skills; this file
records the host limits a busy workspace build depends on.

## Host write path

`/etc/sysctl.d/99-io-tuning.conf` caps dirty page cache at 1 GiB and starts
background writeback at 256 MiB (`vm.dirty_bytes=1073741824`,
`vm.dirty_background_bytes=268435456`). The kernel defaults let a build
accumulate several GiB of dirty pages, which parks linkers in `D` state and
stalls the desktop. `sysctl --system` reads the same file at boot.

## Build slice and IO weight

Every worker, run owner, and peer the dashboard starts runs inside
`devboard.slice`. The slice and each transient scope under it carry
`IOWeight=10`, so a build competes with the desktop's default weight of 100
instead of one-for-one. `DEVBOARD_IO_WEIGHT` overrides the value; the governor
writes the property with the memory properties in one `systemctl
set-property` transaction. The `devboard-io-tuning.service` system unit
persists the delegation of the `io` controller to the user slice and
calibrates `io.cost.qos` and `io.cost.model` for the root device.

`IOWriteBandwidthMax` stays unset: the weight is the only IO control the
harness applies, and the dirty-page caps bound the write path.

## Linker

The workspace links with `mold` from the apt package `mold` (2.40.4 or newer).
`.cargo/config.toml` adds `-fuse-ld=mold` for the host target. Rebuilding the
harness without `mold` installed fails at the first link instead of silently
falling back to the serial system `ld`.

## Reclamation

Build output is regenerable and is reclaimed when no process is working inside
it: `target/` and `.devboard/target/` under `.worktree/*`,
`.devboard/.test-tmp`, and `.devboard/target/debug` beyond its 20 GiB cap. A
target directory whose working directory belongs to a live process is skipped
and named; the pass never signals `cargo`, `rustc`, or `ld`, and it never
removes a worktree, branch, tracked file, or commit.
