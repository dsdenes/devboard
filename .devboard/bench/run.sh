#!/usr/bin/env bash
# Measure the Rust harness, optionally beside the archived TypeScript baseline.
#
# Usage:
#   bash bench/run.sh --rust target/debug/devboard --out bench/report.md
#   bash bench/run.sh --typescript "bun <baseline>/contract/serve-typescript.ts" \
#     --rust target/debug/devboard --out bench/report.md
#
# The command documented in README.md runs without --typescript: the archived
# baseline column is named by --baseline (or the archive the report carries),
# so reproduction never needs the retired TypeScript tree.
#
# Each side starts from the same fixture with a private STATE_DIR and REPO_DIR
# under .devboard/.bench-work and is stopped when the measurement ends.
set -euo pipefail

harness=$(cd -- "$(dirname -- "$0")/.." && pwd)
out="$harness/bench/report.md"
typescript=""
rust=""
iterations=200
skip_suites=0
baseline="archived TypeScript baseline at eb4d4e22 (bench/report.md history)"
ts_suite="bun test"
rust_suite="cargo test --workspace"
ts_release="bun run build"
rust_release="cargo build --release -p devboard"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --typescript) typescript=$2; shift 2 ;;
    --rust) rust=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --iterations) iterations=$2; shift 2 ;;
    --baseline) baseline=$2; shift 2 ;;
    --skip-suites) skip_suites=1; shift ;;
    --typescript-suite) ts_suite=$2; shift 2 ;;
    --rust-suite) rust_suite=$2; shift 2 ;;
    --typescript-release) ts_release=$2; shift 2 ;;
    --rust-release) rust_release=$2; shift 2 ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) printf 'bench: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [ -z "$rust" ]; then
  printf 'bench: --rust is required\n' >&2
  exit 2
fi

work="$harness/.bench-work"
rm -rf "$work"
mkdir -p "$work/rust/state" "$work/rust/repo" "$work/static"
cp -r "$harness/contract/fixtures/repo/." "$work/rust/repo/"
cp -r "$harness/contract/fixtures/static/." "$work/static/"
if [ -n "$typescript" ]; then
  mkdir -p "$work/typescript/state" "$work/typescript/repo"
  cp -r "$harness/contract/fixtures/repo/." "$work/typescript/repo/"
fi
export DEVBOARD_DASHBOARD_TOKEN=bench-token
token="$DEVBOARD_DASHBOARD_TOKEN"

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

start_side() {
  local name=$1 command=$2 root=$3
  local port
  port=$(free_port)
  HOST=127.0.0.1 PORT="$port" \
    ADRS_DIR="$root/repo/adrs" REPO_DIR="$root/repo" \
    GOAL_FILE="$root/repo/GOAL.md" STATIC_DIR="$work/static" \
    STATE_DIR="$root/state" DEVBOARD_UPDATE_INTERVAL_MS=3600000 \
    bash -c "$command" >"$work/$name.log" 2>&1 &
  local pid=$!
  local started
  started=$(date +%s%N)
  for _ in $(seq 1 600); do
    if curl -fsS -H "Authorization: Bearer $token" "http://127.0.0.1:$port/ready" >/dev/null 2>&1; then
      break
    fi
    sleep 0.05
  done
  local elapsed
  elapsed=$((($(date +%s%N) - started) / 1000000))
  printf '%s %s %s\n' "$pid" "$port" "$elapsed"
}

rust_pid=""
ts_pid=""
ts_cold=0
ts_port=0
if [ -n "$typescript" ]; then
  read -r ts_pid ts_port ts_cold <<<"$(start_side typescript "$typescript" "$work/typescript")"
fi
read -r rust_pid rust_port rust_cold <<<"$(start_side rust "$rust" "$work/rust")"
cleanup() {
  if [ -n "$ts_pid" ]; then kill "$ts_pid" 2>/dev/null || true; fi
  if [ -n "$rust_pid" ]; then kill "$rust_pid" 2>/dev/null || true; fi
  if [ -n "$ts_pid" ]; then wait "$ts_pid" 2>/dev/null || true; fi
  if [ -n "$rust_pid" ]; then wait "$rust_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

rss() {
  awk '/VmRSS/ {print $2}' "/proc/$1/status" 2>/dev/null || echo 0
}

ts_latency='{"p95Ms":0,"p50Ms":0}'
rust_latency=$(cd "$harness" && "$rust" bench --port "$rust_port" --token "$token" --iterations "$iterations")
rust_idle=$(rss "$rust_pid")
rust_loaded=$(rss "$rust_pid")
ts_idle=0
ts_loaded=0
if [ -n "$typescript" ]; then
  ts_idle=$(rss "$ts_pid")
  ts_latency=$(cd "$harness" && "$rust" bench --port "$ts_port" --token "$token" --iterations "$iterations")
  ts_loaded=$(rss "$ts_pid")
fi

ts_suite_line="not run"
rust_suite_line="not run"
if [ "$skip_suites" -eq 0 ]; then
  if [ -n "$typescript" ]; then
    ts_start=$(date +%s%N)
    (cd "$harness" && bash -c "$ts_suite" >"$work/typescript-suite.log" 2>&1) || true
    ts_suite_line="$((($(date +%s%N) - ts_start) / 1000000)) ms"
  fi
  rust_start=$(date +%s%N)
  (cd "$harness" && bash -c "$rust_suite" >"$work/rust-suite.log" 2>&1) || true
  rust_suite_line="$((($(date +%s%N) - rust_start) / 1000000)) ms"
fi

ts_release_line="not run"
if [ -n "$typescript" ]; then
  ts_release_start=$(date +%s%N)
  (cd "$harness" && bash -c "$ts_release" >"$work/typescript-release.log" 2>&1) || true
  ts_release_line="$((($(date +%s%N) - ts_release_start) / 1000000)) ms"
fi
rust_release_start=$(date +%s%N)
(cd "$harness" && bash -c "$rust_release" >"$work/rust-release.log" 2>&1) || true
rust_release_line="$((($(date +%s%N) - rust_release_start) / 1000000)) ms"

python3 - "$out" "$typescript" "$rust" "$ts_latency" "$rust_latency" \
  "$ts_idle" "$rust_idle" "$ts_loaded" "$rust_loaded" \
  "$ts_cold" "$rust_cold" "$ts_suite_line" "$rust_suite_line" \
  "$ts_release_line" "$rust_release_line" "$baseline" <<'PY'
import json
import sys
from pathlib import Path
(
    out,
    ts_command,
    rust_command,
    ts_latency,
    rust_latency,
    ts_idle,
    rust_idle,
    ts_loaded,
    rust_loaded,
    ts_cold,
    rust_cold,
    ts_suite,
    rust_suite,
    ts_release,
    rust_release,
    baseline,
) = sys.argv[1:]
ts = json.loads(ts_latency)
rust = json.loads(rust_latency)
lines = ["# Harness benchmark (Rust)", ""]
lines.append(f"Baseline: {baseline}.")
if ts_command:
    lines.append("")
    lines.append(
        f"Reproduce with: `bash .devboard/bench/run.sh --typescript \"{ts_command}\" "
        f"--rust \"{rust_command}\"`"
    )
    lines.extend(
        [
            "",
            "| Measurement | TypeScript | Rust |",
            "| --- | --- | --- |",
            f"| p95 read latency (ms) | {ts['p95Ms']:.2f} | {rust['p95Ms']:.2f} |",
            f"| p50 read latency (ms) | {ts['p50Ms']:.2f} | {rust['p50Ms']:.2f} |",
            f"| idle RSS (KiB) | {ts_idle} | {rust_idle} |",
            f"| loaded RSS (KiB) | {ts_loaded} | {rust_loaded} |",
            f"| cold start to /ready (ms) | {ts_cold} | {rust_cold} |",
            f"| full suite wall time | {ts_suite} | {rust_suite} |",
            f"| release path wall time | {ts_release} | {rust_release} |",
        ]
    )
else:
    lines.extend(
        [
            "",
            "Reproduce with: `bash .devboard/bench/run.sh --rust "
            f"\"{rust_command}\" --out bench/report.md`",
            "",
            "| Measurement | Rust |",
            "| --- | --- |",
            f"| p95 read latency (ms) | {rust['p95Ms']:.2f} |",
            f"| p50 read latency (ms) | {rust['p50Ms']:.2f} |",
            f"| idle RSS (KiB) | {rust_idle} |",
            f"| loaded RSS (KiB) | {rust_loaded} |",
            f"| cold start to /ready (ms) | {rust_cold} |",
            f"| full suite wall time | {rust_suite} |",
            f"| release path wall time | {rust_release} |",
        ]
    )
lines.extend(["", "No threshold is a pass/fail condition; the report is the deliverable.", ""])
Path(out).write_text("\n".join(lines), encoding="utf-8")
print("\n".join(lines))
PY
