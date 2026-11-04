# Harness benchmark (Rust)

Baseline: archived TypeScript baseline at eb4d4e22 (bench/report.md history).

Reproduce with: `bash .devboard/bench/run.sh --rust "target/debug/devboard" --out bench/report.md`

| Measurement | Rust |
| --- | --- |
| p95 read latency (ms) | 0.15 |
| p50 read latency (ms) | 0.12 |
| idle RSS (KiB) | 44464 |
| loaded RSS (KiB) | 44508 |
| cold start to /ready (ms) | 190 |
| full suite wall time | 253582 ms |
| release path wall time | 85609 ms |

No threshold is a pass/fail condition; the report is the deliverable.
