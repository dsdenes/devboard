# Harness benchmark (Rust)

Baseline: archived TypeScript baseline at eb4d4e22 (bench/report.md history).

Reproduce with: `bash .devboard/bench/run.sh --rust "target/debug/devboard" --out bench/report.md`

| Measurement | Rust |
| --- | --- |
| p95 read latency (ms) | 2.67 |
| p50 read latency (ms) | 0.67 |
| idle RSS (KiB) | 64068 |
| loaded RSS (KiB) | 70908 |
| cold start to /ready (ms) | 6193 |
| full suite wall time | 421263 ms |
| release path wall time | 901 ms |

No threshold is a pass/fail condition; the report is the deliverable.
