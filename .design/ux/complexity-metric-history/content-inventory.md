# Metric history panel — content inventory

| ID | Information | Source | Journey | Enables decision/action | Keep? | Reason |
|---|---|---|---|---|---|---|
| C1 | Metric name (`Files`, `Functions`, `Lines of code`, `Mean cyclomatic`, `Max cyclomatic`, `Complex functions`, `Duplicated lines`, `Maintainability`) | `PROJECT_METRICS` | 1, 2 | Identify which row to read | Yes | Without it no row is addressable |
| C2 | Newest value for the metric | `latest.project[key]` | 1 | Decide whether the current level is acceptable | Yes | The panel's subject |
| C3 | The series shape across the recorded days | `points[].project[key]` | 1, 2 | See direction without reading numbers | Yes | The one thing a table cannot show |
| C4 | The change across the whole recorded window | derived from `points` | 1 | Judge how much the metric moved, not only its direction | Yes | The sparkline normalises per series, so shape alone cannot size the move |
| C5 | The recorded dates, once | `points[].date` | 1, 2 | Place the line in time | Yes | The line is meaningless without a time scale |
| C6 | Panel title `Metric history` | static | 2 | Name the surface | Yes | The section was labelled only for assistive technology |
| C7 | The newest date, the recording clock, the day count | page header (`complexity-summary`) | 1 | Locate the snapshot in time | No | Already stated by the page header; repeating it duplicates a fact |
| C8 | Per-date values of every metric as text | `points[].project[key]` | 1 | Read one day exactly | No | The per-file table and the newest value cover the decisions; eight rows of numbers are noise |
| C9 | Per-series unit (`files`, `cc > 10`, `ratio`, `MI 0-100`) | `PROJECT_METRICS` | 1 | Interpret a number | No | The metric cards above the panel own the unit once |
| C10 | A per-series date axis (the shipped state) | `points[].date` | 1, 2 | Place the line in time | No | Repeating the same three dates eight times is the loudest defect of the shipped panel and C5 carries it once |
| C11 | A framed box around each sparkline (the shipped state) | component CSS | — | — | No | It adds eight borders inside a panel that already has one; the row rule carries the separation |
| C12 | Loading and empty text | `devboard.complexityLoaded` | 3 | Know that nothing is missing | Yes | Eight blank charts claim data that does not exist |

## Conflicts
- C5 against C10: the recorded dates are the same for every metric because one snapshot covers the
  project. C5 wins: one axis for the panel, aligned to the chart column.
- C1/C9 against the metric cards: the cards above already pair each label with its unit and its
  newest value. The panel keeps C1 and C2 because the row must be readable on its own, and drops
  C9 to avoid a third copy of the same pair.
