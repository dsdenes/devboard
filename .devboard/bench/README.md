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
