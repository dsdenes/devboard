<script lang="ts">
  import {
    complexity,
    type ComplexityFileRow,
    type ComplexityPoint,
    type ComplexityProjectRow,
  } from "../complexity.svelte";
  import { connection } from "../connection.svelte";
  import Button from "./ui/button.svelte";
  import PageHeader from "./ui/page-header.svelte";

  interface ProjectMetric {
    key: keyof ComplexityProjectRow;
    label: string;
    unit: string;
    digits: number;
  }

  /** Every project-level metric, one card and one series each. */
  const PROJECT_METRICS: readonly ProjectMetric[] = [
    { key: "files", label: "Files", unit: "files", digits: 0 },
    { key: "functions", label: "Functions", unit: "functions", digits: 0 },
    { key: "loc", label: "Lines of code", unit: "lines", digits: 0 },
    { key: "meanCyclomatic", label: "Mean cyclomatic", unit: "cc", digits: 2 },
    { key: "maxCyclomatic", label: "Max cyclomatic", unit: "cc", digits: 0 },
    { key: "functionsOverThreshold", label: "Complex functions", unit: "cc > 10", digits: 0 },
    { key: "duplicatedLineRatio", label: "Duplicated lines", unit: "ratio", digits: 4 },
    { key: "meanMaintainability", label: "Maintainability", unit: "MI 0-100", digits: 2 },
  ];

  type FileMetricKey = "loc" | "functions" | "duplicatedLineRatio" | "maintainability";

  interface FileMetric {
    key: FileMetricKey;
    label: string;
    digits: number;
  }

  /** Every per-file metric column of the table. */
  const FILE_METRICS: readonly FileMetric[] = [
    { key: "loc", label: "Lines", digits: 0 },
    { key: "functions", label: "Functions", digits: 0 },
    { key: "duplicatedLineRatio", label: "Duplication", digits: 4 },
    { key: "maintainability", label: "Maintainability", digits: 2 },
  ];

  type SortKey = "path" | FileMetricKey;

  /** The chart's drawing box; every series shares one x scale. */
  const CHART_FALLBACK_WIDTH = 240;
  const CHART_HEIGHT = 24;
  const CHART_PADDING_X = 8;
  const CHART_PADDING_Y = 4;

  /**
   * The chart's measured width. The viewBox uses it so the drawing box matches
   * the rendered box: a point stays a circle at any track width, while the line
   * still reaches both edges.
   */
  let chartWidth = $state(0);
  const chartBoxWidth = $derived(chartWidth > 0 ? chartWidth : CHART_FALLBACK_WIDTH);

  /** Each date label's measured width, keyed by its date. */
  const labelWidths = $state<Record<string, number>>({});

  const view = $derived(complexity.complexity);
  const points = $derived(view.points);
  const latest = $derived(view.latest);

  let sortKey = $state<SortKey>("path");
  let sortDirection = $state<"asc" | "desc">("asc");

  // The page reads when it opens and after a reconnect; the server pushes a
  // frame when a new daily snapshot is recorded.
  $effect(() => {
    if (connection.open) complexity.requestComplexity();
  });

  const rows = $derived.by(() => {
    const files = latest?.files ?? [];
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...files].sort((left, right) => {
      const primary =
        sortKey === "path"
          ? left.path.localeCompare(right.path)
          : left[sortKey] - right[sortKey];
      return primary !== 0 ? primary * direction : left.path.localeCompare(right.path);
    });
  });

  function sortBy(key: SortKey): void {
    if (key === sortKey) {
      sortDirection = sortDirection === "asc" ? "desc" : "asc";
      return;
    }
    sortKey = key;
    sortDirection = "asc";
  }

  function ariaSort(key: SortKey): "ascending" | "descending" | "none" {
    if (key !== sortKey) return "none";
    return sortDirection === "asc" ? "ascending" : "descending";
  }

  function format(value: number, digits: number): string {
    return value.toFixed(digits);
  }

  /**
   * The line an empty history or file table shows for the state the last frame
   * left: a frame that could not be read never claims the history is empty.
   */
  function emptyMessage(): string {
    switch (complexity.complexityStatus) {
      case "unreadable":
        return "The last complexity update could not be read.";
      case "loading":
        return "Loading the complexity history…";
      case "recorded":
      case "empty":
        return "No snapshot has been recorded yet.";
    }
  }

  function seriesBounds(values: readonly number[]): { min: number; max: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
    return { min, max };
  }

  function pointX(index: number, count: number): number {
    if (count <= 1) return chartBoxWidth / 2;
    return CHART_PADDING_X + (index * (chartBoxWidth - CHART_PADDING_X * 2)) / (count - 1);
  }

  /**
   * A label's left edge: centred on its point's `x`, then clamped inside the
   * track so the outer labels never reach the value columns.
   */
  function labelLeft(offset: number, width: number): number {
    const max = Math.max(0, chartBoxWidth - width);
    return Math.min(Math.max(offset - width / 2, 0), max);
  }

  function pointY(value: number, bounds: { min: number; max: number }): number {
    const span = bounds.max - bounds.min;
    const ratio = span === 0 ? 0.5 : (value - bounds.min) / span;
    return CHART_HEIGHT - CHART_PADDING_Y - ratio * (CHART_HEIGHT - CHART_PADDING_Y * 2);
  }

  /** The `x,y` pairs one series' polyline follows. */
  function polyline(values: readonly number[], bounds: { min: number; max: number }): string {
    return values
      .map((value, index) => `${pointX(index, values.length)},${pointY(value, bounds)}`)
      .join(" ");
  }

  /**
   * The date labels one series shows: every date while they still fit, and
   * first, middle, and last once the history is long. Each label carries the
   * index of the point it names, so it can be placed on that point's `x`.
   */
  function dateLabels(
    history: readonly ComplexityPoint[],
  ): Array<{ date: string; text: string; index: number }> {
    const count = history.length;
    if (count === 0) return [];
    const indexes =
      count <= 5
        ? history.map((_, index) => index)
        : [...new Set([0, Math.floor((count - 1) / 2), count - 1])];
    const labels: Array<{ date: string; text: string; index: number }> = [];
    for (const index of indexes) {
      const point = history[index];
      if (point === undefined) continue;
      labels.push({ date: point.date, text: point.date.slice(5), index });
    }
    return labels;
  }

  /** The signed move across the whole window, or null while it has one day. */
  function windowChange(values: readonly number[]): number | null {
    if (values.length < 2) return null;
    const first = values[0];
    const last = values[values.length - 1];
    if (first === undefined || last === undefined) return null;
    return last - first;
  }

  /** The window move as a signed figure; blank when the window has one day. */
  function formatChange(change: number | null, digits: number): string {
    if (change === null) return "";
    const magnitude = Math.abs(change).toFixed(digits);
    if (Number(magnitude) === 0) return "0";
    return `${change > 0 ? "+" : "−"}${magnitude}`;
  }
</script>

<div class="mode-body" data-testid="complexity-page">
  <PageHeader title="Complexity" layout="bar" testid="devboard-header">
    {#snippet meta()}
      <span
        class="complexity-summary"
        data-testid="complexity-summary"
        data-count={points.length}
        data-date={latest?.date ?? ""}
        data-recorded-at={latest?.recordedAt ?? ""}
      >
        {#if latest !== null}
          Latest {latest.date} · recorded {latest.recordedAt} · {points.length}
          {points.length === 1 ? "recorded date" : "recorded dates"}
        {:else if complexity.complexityStatus === "unreadable"}
          Complexity history unreadable
        {:else}
          No snapshot recorded yet
        {/if}
      </span>
    {/snippet}
  </PageHeader>

  <section class="complexity-cards" aria-label="Project metrics">
    {#each PROJECT_METRICS as metric (metric.key)}
      <article
        class="complexity-card"
        data-testid="complexity-card"
        data-metric={metric.key}
        data-value={latest === null ? "" : format(latest.project[metric.key], metric.digits)}
      >
        <span class="complexity-card__label">{metric.label}</span>
        <span class="complexity-card__value mono">
          {latest === null ? "—" : format(latest.project[metric.key], metric.digits)}
        </span>
        <span class="complexity-card__unit">{metric.unit}</span>
      </article>
    {/each}
  </section>

  <section class="panel complexity-panel" aria-label="Metric history">
    <div class="panel__header">
      <h2 class="panel__title">Metric history</h2>
    </div>
    <div class="panel__body complexity-history__body">
      {#if complexity.complexityStatus === "unreadable" && points.length > 0}
        <p class="complexity-history__notice" data-testid="complexity-history-unreadable">
          The last complexity update could not be read; showing the last recorded history.
        </p>
      {/if}
      {#if points.length === 0}
        <p class="complexity-history__empty" data-testid="complexity-history-empty">
          {emptyMessage()}
        </p>
      {:else}
        {#each PROJECT_METRICS as metric (metric.key)}
          {@const values = points.map((point) => point.project[metric.key])}
          {@const bounds = seriesBounds(values)}
          {@const change = windowChange(values)}
          <article
            class="complexity-series"
            data-testid="complexity-series"
            data-metric={metric.key}
            data-points={points.length}
          >
            <span class="complexity-series__label">{metric.label}</span>
            <svg
              class="complexity-series__chart"
              bind:clientWidth={chartWidth}
              viewBox={`0 0 ${chartBoxWidth} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={`${metric.label} across ${points.length} recorded dates`}
            >
              {#if values.length > 1}
                <polyline
                  class="complexity-series__line"
                  data-testid="complexity-series-line"
                  data-metric={metric.key}
                  points={polyline(values, bounds)}
                  fill="none"
                  vector-effect="non-scaling-stroke"
                />
              {/if}
              {#each points as point, index (point.date)}
                <circle
                  class="complexity-series__point"
                  data-testid="complexity-series-point"
                  data-metric={metric.key}
                  data-date={point.date}
                  data-value={format(values[index] ?? 0, metric.digits)}
                  cx={pointX(index, points.length)}
                  cy={pointY(values[index] ?? 0, bounds)}
                  r={2}
                />
              {/each}
              {#if points.length > 0}
                <circle
                  class="complexity-series__latest"
                  data-testid="complexity-series-latest"
                  data-metric={metric.key}
                  data-date={latest?.date ?? ""}
                  cx={pointX(points.length - 1, points.length)}
                  cy={pointY(values[values.length - 1] ?? 0, bounds)}
                  r={3.5}
                />
              {/if}
            </svg>
            <span class="complexity-series__latest-value mono">
              {latest === null ? "—" : format(latest.project[metric.key], metric.digits)}
            </span>
            <span
              class="complexity-series__change mono"
              data-testid="complexity-series-change"
              data-metric={metric.key}
              title={change === null ? "" : `Change since ${points[0]?.date ?? ""}`}
            >
              {formatChange(change, metric.digits)}
            </span>
          </article>
        {/each}
      {/if}
    </div>
    {#if points.length > 0}
      <div class="complexity-history__axis">
        <div class="complexity-series__dates">
          {#each dateLabels(points) as label (label.date)}
            {@const offset = pointX(label.index, points.length)}
            <span
              class="complexity-series__date mono"
              data-date={label.date}
              data-offset={offset}
              style={`left: ${labelLeft(offset, labelWidths[label.date] ?? 0)}px`}
              bind:clientWidth={labelWidths[label.date]}
            >{label.text}</span>
          {/each}
        </div>
      </div>
    {/if}
  </section>

  <section class="panel complexity-panel complexity-panel--files" aria-label="Per-file measurements">
    <div class="complexity-table-wrap">
      <table class="complexity-table" data-testid="complexity-file-table">
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort("path")}>
              <Button
                bare
                data-testid="complexity-sort"
                data-sort="path"
                data-direction={sortKey === "path" ? sortDirection : "none"}
                onclick={() => sortBy("path")}
              >
                File
              </Button>
            </th>
            {#each FILE_METRICS as metric (metric.key)}
              <th scope="col" class="complexity-table__numeric" aria-sort={ariaSort(metric.key)}>
                <Button
                  bare
                  data-testid="complexity-sort"
                  data-sort={metric.key}
                  data-direction={sortKey === metric.key ? sortDirection : "none"}
                  onclick={() => sortBy(metric.key)}
                >
                  {metric.label}
                </Button>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.path)}
            <tr
              class="complexity-table__row"
              data-testid="complexity-file-row"
              data-path={row.path}
            >
              <td class="complexity-table__path mono">{row.path}</td>
              {#each FILE_METRICS as metric (metric.key)}
                <td
                  class="complexity-table__numeric mono"
                  data-testid="complexity-cell"
                  data-metric={metric.key}
                >
                  {format(row[metric.key], metric.digits)}
                </td>
              {/each}
            </tr>
          {:else}
            <tr>
              <td colspan={FILE_METRICS.length + 1} class="empty">
                {emptyMessage()}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
</div>

<style>
  .complexity-summary {
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .complexity-cards {
    display: grid;
    flex: 0 0 auto;
    gap: 8px;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  }

  .complexity-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    min-width: 0;
  }

  .complexity-card__label {
    color: var(--muted-foreground);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .complexity-card__value {
    color: var(--foreground);
    font-size: 18px;
    font-weight: 600;
    line-height: 1.1;
  }

  .complexity-card__unit {
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 10px;
  }

  .complexity-panel {
    --complexity-tracks: minmax(96px, 148px) minmax(0, 1fr) 72px 64px;
    flex: 0 1 auto;
    min-height: 0;
  }

  .complexity-panel--files {
    flex: 1 1 45%;
    padding: 8px;
  }

  /* One grid for every row and for the axis, so the tracks line up. */
  .complexity-history__body {
    padding: 8px 8px 4px;
  }

  .complexity-history__empty {
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
  }

  .complexity-history__notice {
    color: var(--warning);
    font-size: 12px;
    margin: 0 0 6px;
  }

  .complexity-series {
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    display: grid;
    gap: 0 10px;
    grid-template-columns: var(--complexity-tracks);
    padding: 4px 0;
  }

  .complexity-series:last-child {
    border-bottom: none;
  }

  .complexity-series__label {
    color: var(--foreground);
    font-size: 11px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .complexity-series__latest-value {
    color: var(--foreground);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .complexity-series__change {
    color: var(--muted-foreground);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .complexity-series__chart {
    display: block;
    height: 24px;
    min-width: 0;
    width: 100%;
  }

  .complexity-series__line {
    stroke: var(--accent);
    stroke-width: 1.5;
  }

  .complexity-series__point {
    fill: var(--muted-foreground);
  }

  .complexity-series__latest {
    fill: var(--accent);
    stroke: var(--surface);
    stroke-width: 1.5;
  }

  .complexity-history__axis {
    border-top: 1px solid var(--border-subtle);
    display: grid;
    gap: 0 10px;
    grid-template-columns: var(--complexity-tracks);
    padding: 4px 8px 8px;
  }

  /*
   * The labels use the chart's own point positions: each one is absolutely
   * placed from `pointX`, which already carries the chart's 8px inset.
   */
  .complexity-series__dates {
    grid-column: 2;
    height: 13px;
    position: relative;
  }

  .complexity-series__date {
    color: var(--muted-foreground);
    font-size: 10px;
    line-height: 1;
    position: absolute;
    top: 0;
    white-space: nowrap;
  }

  .complexity-table-wrap {
    height: 100%;
    min-height: 0;
    overflow: auto;
  }

  .complexity-table {
    border-collapse: collapse;
    font-size: 12px;
    width: 100%;
  }

  .complexity-table th {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    padding: 0;
    position: sticky;
    text-align: left;
    text-transform: uppercase;
    top: 0;
  }

  .complexity-table td {
    border-bottom: 1px solid var(--border-subtle);
    padding: 5px 8px;
  }

  .complexity-table tbody tr:hover {
    background: var(--row-hover);
  }

  .complexity-table__numeric {
    text-align: right;
  }

  :global(.complexity-table th > button) {
    color: var(--foreground);
    font-size: 11px;
    padding: 6px 8px;
    text-align: inherit;
    text-transform: uppercase;
    width: 100%;
  }

  .complexity-table__path {
    overflow-wrap: anywhere;
  }
</style>
