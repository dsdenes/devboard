<script lang="ts">
  import Inbox from "lucide-svelte/icons/inbox";
  import { sortAgentIssues } from "../../../server/agents/registry";
  import type { AgentIssueRow } from "../types";

  interface Props {
    issues: AgentIssueRow[];
    agentLabel: string;
  }

  let { issues, agentLabel }: Props = $props();

  /** A local clock reading; the raw ISO value stays in the cell tooltip. */
  function filedLabel(value: string): string {
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

  const rows = $derived(sortAgentIssues(issues));
</script>

<div class="agent-issues" data-testid="agent-issues">
  {#if rows.length === 0}
    <div class="agent-issues__empty" data-testid="agent-issues-empty">
      <div class="agent-issues__empty-body">
        <span class="agent-issues__empty-icon" aria-hidden="true">
          <Inbox size={20} strokeWidth={1.5} />
        </span>
        <p class="agent-issues__empty-title">No issues filed yet</p>
        <p class="agent-issues__empty-copy">
          {agentLabel} files significant findings here after each run.
        </p>
      </div>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="agent-issues-table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Category</th>
            <th scope="col">Filed</th>
            <th scope="col">State</th>
            <th scope="col">Shipped</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.url)}
            <tr
              data-testid="agent-issue"
              data-url={row.url}
              data-state={row.state}
              data-version={row.version ?? ""}
            >
              <td class="agent-issues-table__title">
                <a
                  data-testid="agent-issue-title"
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={row.title}
                >
                  {row.title}
                </a>
              </td>
              <td class="mono" data-testid="agent-issue-category">{row.category ?? "—"}</td>
              <td class="mono" title={row.filedAt}>
                <time data-testid="agent-issue-filed" datetime={row.filedAt}>
                  {filedLabel(row.filedAt)}
                </time>
              </td>
              <td>
                <span
                  class="badge"
                  data-tone={row.state === "pending"
                    ? "accent"
                    : row.state === "implemented"
                      ? "success"
                      : undefined}
                  data-testid="agent-issue-state"
                >
                  {row.state}
                </span>
              </td>
              <td class="mono" data-testid="agent-issue-version">{row.version ?? "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .agent-issues {
    height: 100%;
    min-height: 0;
    overflow: auto;
  }

  .agent-issues__empty {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 100%;
    padding: 24px 16px;
    text-align: center;
  }

  .agent-issues__empty-body {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 360px;
  }

  .agent-issues__empty-icon {
    color: var(--muted-foreground);
    display: flex;
    margin-bottom: 4px;
  }

  .agent-issues__empty-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    margin: 0;
  }

  .agent-issues__empty-copy {
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.45;
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

  th:nth-child(1) {
    width: 40%;
  }
  th:nth-child(2) {
    width: 14%;
  }
  th:nth-child(3) {
    width: 18%;
  }
  th:nth-child(4) {
    width: 15%;
  }
  th:nth-child(5) {
    width: 13%;
  }

  .agent-issues-table__title {
    overflow-wrap: anywhere;
  }

  .agent-issues-table__title a {
    color: var(--foreground);
    text-decoration: none;
  }

  .agent-issues-table__title a:hover {
    color: var(--accent);
    text-decoration: underline;
  }
</style>
