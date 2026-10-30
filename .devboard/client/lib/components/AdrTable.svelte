<script lang="ts">
  import { createTable, FlexRender } from "@tanstack/svelte-table";
  import { tableFeatures } from "@tanstack/table-core";
  import { goal } from "../goal.svelte";
  import { recordStatusTone } from "../record-status";
  import type { AdrRecord } from "../types";
  import Button from "./ui/button.svelte";

  interface Props {
    /** The rows to render; the page owns filtering, the table owns density. */
    records: AdrRecord[];
    onopen: (record: AdrRecord) => void;
    onstart: (record: AdrRecord) => void;
  }

  let { records, onopen, onstart }: Props = $props();

  const features = tableFeatures({});

  const columns = [
    { id: "title", header: "Title", accessorKey: "title" },
    { id: "status", header: "Document status", accessorKey: "status" },
    { id: "state", header: "Implementation", accessorKey: "pending" },
    { id: "file", header: "File", accessorKey: "file" },
    { id: "summary", header: "Decision summary", accessorKey: "summary" },
    { id: "actions", header: "Action", accessorKey: "file" },
  ];

  const table = createTable({
    features,
    get data() {
      return records as unknown as Array<Record<string, unknown>>;
    },
    get columns() {
      return columns as never;
    },
    getRowId: (record: Record<string, unknown>) => String(record.file),
  });

  function activate(record: AdrRecord): void {
    onopen(record);
  }
</script>

<div class="table-wrap">
  <table class="adr-table" data-testid="adr-table" aria-label="ADR records">
    <thead>
      {#each table.getHeaderGroups() as group (group.id)}
        <tr>
          {#each group.headers as header (header.id)}
            <th scope="col"><FlexRender {header} /></th>
          {/each}
        </tr>
      {/each}
    </thead>
    <tbody>
      {#each table.getRowModel().rows as row (row.id)}
        {@const record = row.original as unknown as AdrRecord}
        <tr
          data-testid="record"
          data-file={record.file}
          data-pending={record.pending}
          data-next={goal.next === record.file}
          data-active={goal.runFile === record.file}
          data-command={`goal.adr.open.${record.file}`}
          tabindex="0"
          onclick={() => activate(record)}
          onkeydown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              activate(record);
            }
          }}
        >
          <td class="adr-title" title={record.title}>
            <span class="adr-title__text">{record.title}</span>
            {#if goal.next === record.file}
              <span class="badge" data-tone="accent" data-testid="next-marker">Next</span>
            {/if}
          </td>
          <td>
            <span
              class="badge"
              data-tone={recordStatusTone(record.status)}
              data-testid="record-status-badge"
            >
              {record.status || "Unknown"}
            </span>
          </td>
          <td>{record.pending ? "Pending" : "Resolved"}</td>
          <td><code data-testid="record-file">{record.file}</code></td>
          <td class="adr-summary" data-testid="record-summary" title={record.summary}>
            {record.summary || "No decision summary recorded."}
          </td>
          <td class="adr-action">
            {#if record.pending}
              <Button
                variant={goal.next === record.file ? "default" : "outline"}
                size="sm"
                class="cursor-pointer"
                data-testid="start"
                data-file={record.file}
                data-command={`goal.adr.start.${record.file}`}
                title={goal.startLifecycleTitle}
                aria-label={`Start the implementation of ${record.title}`}
                disabled={goal.runStartDisabled}
                onclick={(event) => {
                  event.stopPropagation();
                  onstart(record);
                }}
              >
                Start
              </Button>
            {/if}
          </td>
        </tr>
      {:else}
        <tr>
          <td colspan={columns.length} class="empty">No records match this filter.</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    width: 100%;
  }

  table {
    border-collapse: collapse;
    font-size: 12px;
    table-layout: fixed;
    width: 100%;
  }

  th {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 5px 8px;
    position: sticky;
    text-align: left;
    text-transform: uppercase;
    top: 0;
    z-index: 1;
  }

  td {
    border-bottom: 1px solid var(--border-subtle);
    height: 28px;
    line-height: 26px;
    max-width: 0;
    overflow: hidden;
    padding: 0 8px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  tbody tr {
    cursor: pointer;
    height: 28px;
  }

  tbody tr:hover {
    background: var(--row-hover);
  }

  tbody tr:focus-visible {
    background: var(--row-hover);
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  th:nth-child(1) {
    width: 27%;
  }
  th:nth-child(2) {
    width: 11%;
  }
  th:nth-child(3) {
    width: 11%;
  }
  th:nth-child(4) {
    width: 19%;
  }
  th:nth-child(5) {
    width: 22%;
  }
  th:nth-child(6) {
    width: 10%;
  }

  .adr-title {
    align-items: center;
    display: flex;
    gap: 6px;
    max-width: none;
    min-width: 0;
    overflow: hidden;
  }

  .adr-title__text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .adr-title .badge {
    flex: 0 0 auto;
  }

  .adr-action {
    line-height: 24px;
    vertical-align: middle;
  }

  .empty {
    color: var(--muted-foreground);
    text-align: center;
  }
</style>
