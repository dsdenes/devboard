# Harness benchmark (TypeScript baseline and Rust)

Reproduce with: `bash .devboard/bench/run.sh --typescript "bun contract/serve-typescript.ts" --rust "target/debug/devboard"`

| Measurement | TypeScript | Rust |
| --- | --- | --- |
| p95 read latency (ms) | 0.41 | 0.18 |
| p50 read latency (ms) | 0.09 | 0.13 |
| idle RSS (KiB) | 64100 | 34120 |
| loaded RSS (KiB) | 66096 | 35900 |
| cold start to /ready (ms) | 157 | 41 |
| full suite wall time | 483016 ms | 199949 ms |
| release path wall time | 4611 ms | 102288 ms |

No threshold is a pass/fail condition; the report is the deliverable.
