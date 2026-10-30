<script lang="ts">
  import type { Snippet } from "svelte";
  import { createTable, FlexRender } from "@tanstack/svelte-table";
  import { tableFeatures } from "@tanstack/table-core";

  interface Props {
    columns: unknown[];
    rows: Array<Record<string, unknown>>;
    "data-testid"?: string;
    rowTestId?: string;
    rowAttrs?: (row: Record<string, unknown>) => Record<string, string | undefined>;
    rowCommand?: (row: Record<string, unknown>) => string | undefined;
    onRowActivate?: (row: Record<string, unknown>) => void;
    cellValue?: (row: Record<string, unknown>, columnId: string) => string;
    cell?: Snippet<[Record<string, unknown>, string]>;
    cellAttrs?: (row: Record<string, unknown>, columnId: string) => Record<string, string | undefined>;
    cellTestId?: (row: Record<string, unknown>, columnId: string) => string | undefined;
    getRowId?: (row: Record<string, unknown>, index: number) => string;
    emptyText?: string;
    caption?: string;
    /** Omit the header row; the cells carry all the information. */
    hideHeader?: boolean;
    /** Fixed column widths keyed by column id; aligns repeated tables. */
    columnWidths?: Record<string, string>;
    compact?: boolean;
    /** Let cells wrap instead of truncating to one line. */
    wrap?: boolean;
    /** Grow with the page instead of scrolling inside the table. */
    full?: boolean;
  }

  let {
    columns,
    rows,
    "data-testid": testid,
    rowTestId,
    rowAttrs,
    rowCommand,
    onRowActivate,
    cellValue,
    cell,
    cellAttrs,
    cellTestId,
    getRowId,
    emptyText = "No records.",
    caption,
    hideHeader = false,
    columnWidths,
    compact = true,
    wrap = false,
    full = false,
  }: Props = $props();

  const features = tableFeatures({});

  const table = createTable({
    features,
    get data() {
      return rows;
    },
    get columns() {
      return columns as never;
    },
    getRowId: (row: Record<string, unknown>, index: number) => getRowId?.(row, index) ?? String(index),
  });

  function attributes(row: Record<string, unknown>): Record<string, string | undefined> {
    const attrs = rowAttrs?.(row) ?? {};
    const command = rowCommand?.(row);
    return command === undefined ? attrs : { ...attrs, "data-command": command };
  }
</script>

<div class="table-wrap" class:compact class:wrap class:full class:widths={columnWidths !== undefined}>
  <table data-testid={testid} aria-label={caption}>
    {#if caption !== undefined}
      <caption>{caption}</caption>
    {/if}
    {#if columnWidths !== undefined}
      <colgroup>
        {#each columns as column, index (index)}
          {@const id = (column as { id?: unknown }).id}
          <col style:width={typeof id === "string" ? columnWidths[id] : undefined} />
        {/each}
      </colgroup>
    {/if}
    {#if !hideHeader}
      <thead>
        {#each table.getHeaderGroups() as group (group.id)}
          <tr>
            {#each group.headers as header (header.id)}
              <th scope="col">
                {#if !header.isPlaceholder}
                  <FlexRender header={header} />
                {/if}
              </th>
            {/each}
          </tr>
        {/each}
      </thead>
    {/if}
    <tbody>
      {#each table.getRowModel().rows as row (row.id)}
        {@const data = row.original as Record<string, unknown>}
        <tr
          data-testid={rowTestId}
          {...attributes(data)}
          tabindex={onRowActivate === undefined ? undefined : 0}
          onclick={onRowActivate === undefined ? undefined : () => onRowActivate(data)}
          onkeydown={onRowActivate === undefined
            ? undefined
            : (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRowActivate(data);
                }
              }}
        >
          {#each row.getAllCells() as tableCell (tableCell.id)}
            <td
              {...cellAttrs?.(data, tableCell.column.id) ?? {}}
              data-testid={cellTestId?.(data, tableCell.column.id)}
            >
              {#if cell !== undefined}
                {@render cell(data, tableCell.column.id)}
              {:else if cellValue !== undefined}
                {cellValue(data, tableCell.column.id)}
              {:else}
                <FlexRender cell={tableCell} />
              {/if}
            </td>
          {/each}
        </tr>
      {:else}
        <tr class="empty-row">
          <td colspan={columns.length}>{emptyText}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table-wrap {
    min-height: 0;
    overflow: auto;
    width: 100%;
  }

  table {
    border-collapse: collapse;
    font-size: 12px;
    table-layout: auto;
    width: 100%;
  }

  .widths table {
    table-layout: fixed;
  }

  caption {
    color: var(--muted-foreground);
    font-size: 12px;
    padding: 4px 6px;
    text-align: left;
  }

  th {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 3px 8px;
    position: sticky;
    text-align: left;
    text-transform: uppercase;
    top: 0;
    white-space: nowrap;
    z-index: 1;
  }

  td {
    border-bottom: 1px solid var(--border-subtle);
    color: var(--foreground);
    padding: 0 8px;
    vertical-align: middle;
  }

  tbody tr {
    height: 28px;
    max-height: 32px;
  }

  tbody tr[tabindex="0"] {
    cursor: pointer;
  }

  tbody tr:hover,
  tbody tr:focus-visible {
    background: var(--row-hover);
  }

  tbody tr:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  .compact td {
    line-height: 26px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .wrap tbody tr {
    height: auto;
    max-height: none;
  }

  .wrap td {
    line-height: 1.45;
    max-width: none;
    overflow: visible;
    padding-bottom: 5px;
    padding-top: 5px;
    text-overflow: clip;
    vertical-align: top;
    white-space: normal;
  }

  .full {
    overflow: visible;
  }

  .empty-row td {
    color: var(--muted-foreground);
    height: 32px;
    text-align: center;
  }
</style>
