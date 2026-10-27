<script lang="ts">
  import type { ScoutIssueRow } from "../types";

  interface Props {
    issues: ScoutIssueRow[];
  }

  let { issues }: Props = $props();

  /** A local clock reading; the raw ISO value stays in the cell tooltip. */
  function createdLabel(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  /** Newest creation first; the number breaks a same-instant tie. */
  const rows = $derived(
    [...issues].sort((left, right) => {
      const leftAt = Date.parse(left.createdAt);
      const rightAt = Date.parse(right.createdAt);
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
        return rightAt - leftAt;
      }
      return right.number - left.number;
    }),
  );
</script>

<section class="panel" aria-label="Auto Scout issues">
  <div class="panel__header">
    <h2 class="panel__title">Filed issues</h2>
    <span class="panel__subtitle">{rows.length}</span>
  </div>
  <div class="panel__body panel__body--flush" data-testid="scout-issues">
    {#if rows.length === 0}
      <div class="scout-issues__empty" data-testid="scout-issues-empty">
        <p class="scout-issues__empty-title">No issues filed yet</p>
        <p class="muted">Auto Scout files scored findings here.</p>
      </div>
    {:else}
      <div class="table-wrap">
        <table class="scout-issues-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Created</th>
              <th scope="col">Category</th>
              <th scope="col">State</th>
              <th scope="col">Shipped</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.number)}
              <tr
                data-testid="scout-issue"
                data-number={row.number}
                data-state={row.state}
                data-version={row.version ?? "—"}
              >
                <td class="scout-issues-table__title">
                  <a
                    data-testid="scout-issue-title"
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    title={row.title}
                  >
                    {row.title}
                  </a>
                </td>
                <td class="mono" data-testid="scout-issue-created" title={row.createdAt}>
                  <time datetime={row.createdAt}>{createdLabel(row.createdAt)}</time>
                </td>
                <td data-testid="scout-issue-type">{row.category ?? "—"}</td>
                <td>
                  <span
                    class="badge"
                    data-tone={row.state === "pending" ? "accent" : "success"}
                    data-testid="scout-issue-state"
                  >
                    {row.state}
                  </span>
                </td>
                <td class="mono" data-testid="scout-issue-version">{row.version ?? "—"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</section>

<style>
  .scout-issues__empty {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 100%;
    padding: 16px 12px;
  }

  .scout-issues__empty-title {
    font-size: 12px;
    font-weight: 600;
    margin: 0 0 2px;
  }

  .scout-issues__empty p {
    margin: 0;
  }

  .table-wrap {
    overflow: auto;
    width: 100%;
  }

  tbody tr:hover {
    background: var(--row-hover);
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
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    text-align: left;
    text-transform: uppercase;
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

  th:nth-child(1) {
    width: 40%;
  }
  th:nth-child(2) {
    width: 20%;
  }
  th:nth-child(3) {
    width: 12%;
  }
  th:nth-child(4) {
    width: 15%;
  }
  th:nth-child(5) {
    width: 13%;
  }

  .scout-issues-table__title {
    overflow-wrap: anywhere;
  }

  .scout-issues-table__title a {
    color: var(--foreground);
    text-decoration: none;
  }

  .scout-issues-table__title a:hover {
    color: var(--accent);
    text-decoration: underline;
  }
</style>
