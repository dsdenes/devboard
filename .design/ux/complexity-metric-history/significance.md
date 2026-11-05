# Metric history panel — significance

```text
score = 20 × (0.35·goal + 0.25·action + 0.15·frequency + 0.15·unique + 0.10·risk)
```

| ID | Information | Goal 0–5 | Action 0–5 | Frequency 0–5 | Unique 0–5 | Risk 0–5 | Score 0–100 | Priority | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| C2 | Newest value | 5 | 3 | 4 | 3 | 2 | 74 | P1 | Row's trailing value, `mono-small` tabular |
| C3 | Series shape | 5 | 3 | 4 | 5 | 2 | 78 | P1 | Row's chart track |
| C4 | Whole-window change | 4 | 3 | 3 | 4 | 2 | 65 | P1 | Row's trailing change column |
| C1 | Metric name | 5 | 2 | 4 | 2 | 1 | 65 | P1 | Row's leading label track |
| C5 | Recorded dates | 4 | 2 | 4 | 3 | 1 | 61 | P1 | One shared axis under the rows |
| C6 | Panel title | 2 | 1 | 3 | 1 | 1 | 33 | P3 | Named, because the panel owns a heading in every sibling panel |
| C12 | Loading / empty text | 2 | 2 | 1 | 3 | 2 | 40 | P2 | One muted line in the panel body |
| C7 | Date, clock, day count | 3 | 1 | 4 | 1 | 1 | 43 | P2 | Dropped here: the page header states it |
| C8 | Every per-date value as text | 3 | 2 | 2 | 1 | 2 | 42 | P2 | Dropped: the per-file table carries exact numbers |
| C9 | Metric unit | 2 | 1 | 3 | 1 | 1 | 34 | P3 | Dropped: the metric cards own it |

## Deduplication
- C2 and C4 both describe "where the metric stands". They stay separate because C2 is absolute and
  C4 is relative to the first recorded day; a single track could not carry both without a second
  label.
- C3 and C5 are the same fact in two forms (shape over time). They must sit adjacent, so the axis
  is one row under the chart column rather than repeated per row.

## Bands
- No P0: the panel is secondary to the page's metric cards, which state the current level.
- P1 items form one row per metric: name, shape, newest value, change.
- P3 C6 is retained only as the panel's heading, which every sibling panel carries.
