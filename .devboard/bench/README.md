# Harness benchmark and shadow reports

`report.md` is the committed benchmark. Reproduce it from the current tree:

```bash
bash .devboard/bench/run.sh --rust target/debug/devboard --out bench/report.md
```

The baseline is named in the generated report: the archived TypeScript baseline at
`eb4d4e22`, whose measurements the committed two-column report carries. The command never needs
`contract/serve-typescript.ts`, the retired TypeScript server, or a second checkout. Passing
`--typescript "<command>"` measures a live baseline beside Rust when an archived tree is
available; otherwise the report is the Rust column.

The shadow soak compares every read live and every mutating command against its recorded corpus
answer, state tree, and repository tree. Reproduce it with:

```bash
cd .devboard
cargo run -p devboard-shadow -- --report ../shadow-report.json --window 60 --iterations 1
```

`shadow-report.json` is regenerated from that run. It records one entry per command, at least one
comparison per command, and `unexplained: []`; it needs no TypeScript baseline.
