<script lang="ts">
  import type { ScoutIssueRow } from "../types";

  interface Props {
    issues: ScoutIssueRow[];
  }

  let { issues }: Props = $props();

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
  <div class="panel__body" data-testid="scout-issues">
    {#if rows.length === 0}
      <p class="muted" data-testid="scout-issues-empty">No issues filed yet.</p>
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
                <td class="mono" data-testid="scout-issue-created">{row.createdAt}</td>
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
  .table-wrap {
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
    width: 44%;
  }
  th:nth-child(2) {
    width: 22%;
  }
  th:nth-child(3) {
    width: 12%;
  }
  th:nth-child(4) {
    width: 12%;
  }
  th:nth-child(5) {
    width: 10%;
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
