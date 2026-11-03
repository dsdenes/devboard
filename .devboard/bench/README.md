# Harness benchmark and shadow reports

`report.md` is the committed two-column benchmark. It was produced with:

```bash
bash .devboard/bench/run.sh \
  --typescript "bun contract/serve-typescript.ts" \
  --rust "target/debug/devboard"
```

The TypeScript column comes from the pre-cutover tree, which this branch no
longer carries. Reproduce it from the last TypeScript commit without touching
this checkout:

```bash
git worktree add .devboard/.bench-baseline eb4d4e22
ln -s "$PWD/.devboard/node_modules" .devboard/.bench-baseline/node_modules
bash .devboard/bench/run.sh \
  --typescript "bun .devboard/.bench-baseline/contract/serve-typescript.ts" \
  --rust "target/debug/devboard"
```

The shadow soak report was produced the same way with the baseline tree.
`shadow-report.json` records 100 comparisons for every read command and no
unexplained divergence; the soak is meaningful only while the TypeScript
baseline exists, so reproduction checks out the same baseline commit and runs:

```bash
cargo run -p devboard-shadow -- --report shadow-report.json --window 1800 --iterations 100
```

with the baseline script path supplied by the checkout.
