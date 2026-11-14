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

## Test profile

`.devboard/Cargo.toml` sets `[profile.test]` to `debug = 0` and `incremental = false`.
A test binary with full debug info weighs a quarter gigabyte, and the incremental tree
a worktree leaves behind reaches several gigabytes; both are write amplification on a
host that runs several builds at once, and neither changes a test's verdict.
`[profile.release]` and `[profile.dist]` are unchanged.

## Focused Rust gate

`verification_run` with `{"check": "rust:test", "packages": ["<crate>"]}` runs
`cargo test -p <crate>`, and `"tests": ["<target>"]` narrows it to `--test <target>`.
The full workspace suite is not every change's local gate: the Gitea CI Test step runs
it on every push and the Release Train runs it before any tag. A `rust:test` with
neither argument still runs the full runner.

## Build lease

Every cargo build the harness starts — `rust:test`, `rust:clippy`, and the Release
Train's suite — takes one slot of a cross-process lane under
`<STATE_DIR>/build-lane`, which a suite run without a state directory replaces with
`<checkout>/target/tmp/build-lane`. The derived cap is `clamp(cpus / 8, 1, 8)`,
`DEVBOARD_MAX_BUILDS` overrides it inside 1..=64, and a waiting build sleeps until a
slot is free instead of failing; the slot's build gets `CARGO_BUILD_JOBS` of
`ceil(cpus / slots)` when the caller set none. A slot is a `flock(2)` lock, so the
kernel reclaims it when its holder dies. The lane bounds writes only: it never reads or
changes the agent cap or the governor's admission.

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
