<script lang="ts">
  import CircleAlert from "lucide-svelte/icons/circle-alert";
  import Clock from "lucide-svelte/icons/clock";
  import Inbox from "lucide-svelte/icons/inbox";
  import { sortAgentIssues } from "../../../lib/agent-registry.ts";
  import { statusTone } from "../status-tone";
  import type { AgentIssueRow, AgentSync } from "../types";

  interface Props {
    issues: AgentIssueRow[];
    agentLabel: string;
    /** The tracker read behind `issues`; an empty list means zero only when read. */
    sync: AgentSync;
  }

  let { issues, agentLabel, sync }: Props = $props();

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

  /**
   * Only a fresh successful read proves the list. The state is the verdict and
   * `at`/`error` are its evidence, so an aged or failed read is never presented
   * as a current table.
   */
  const read = $derived(sync.state === "ok");
  const lastRead = $derived(sync.at === null ? "never" : filedLabel(sync.at));
  /** Why a read that is not fresh cannot prove its rows, in its own words. */
  const unreadTitle = $derived(
    sync.error !== null
      ? "The tracker could not be read"
      : sync.at === null
        ? "The tracker has not been read yet"
        : "The tracker read is stale",
  );
  const unreadCopy = $derived(
    sync.error !== null
      ? sync.error
      : sync.at === null
        ? `${agentLabel}'s filed issues are unknown until the first read completes.`
        : `${agentLabel}'s filed issues may be out of date until the next successful read.`,
  );
  /** Surviving rows stay, and a read that is not fresh says so above them. */
  const rowsNotice = $derived(
    read || rows.length === 0
      ? null
      : sync.error !== null
        ? `These rows predate a failed read; last read ${lastRead}.`
        : `These rows come from a stale read; last read ${lastRead}.`,
  );
</script>

<div class="agent-issues" data-testid="agent-issues">
  {#if rowsNotice !== null}
    <p
      class="agent-issues__sync"
      data-testid="agent-issues-sync"
      data-sync={sync.state}
      role="status"
    >
      {rowsNotice}
    </p>
  {/if}
  {#if rows.length === 0}
    <div class="agent-issues__empty" data-testid="agent-issues-empty" data-sync={sync.state}>
      <div class="agent-issues__empty-body">
        <span class="agent-issues__empty-icon" aria-hidden="true">
          {#if read}
            <Inbox size={20} strokeWidth={1.5} />
          {:else if sync.error === null}
            <Clock size={20} strokeWidth={1.5} />
          {:else}
            <CircleAlert size={20} strokeWidth={1.5} />
          {/if}
        </span>
        {#if read}
          <p class="agent-issues__empty-title">No issues filed yet</p>
          <p class="agent-issues__empty-copy">
            {agentLabel} files significant findings here after each scan.
          </p>
        {:else}
          <p class="agent-issues__empty-title" data-testid="agent-issues-unread">
            {unreadTitle}
          </p>
          <p class="agent-issues__empty-copy" data-testid="agent-issues-unread-copy">
            Last read {lastRead}.
            {unreadCopy}
          </p>
        {/if}
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
                  data-tone={statusTone(row.state)}
                  data-testid="agent-issue-state"
                >
                  {row.state}
                </span>
              </td>
              <td
                class="mono"
                data-testid="agent-issue-version"
                data-note={row.note ?? ""}
                title={row.note ?? undefined}
              >
                {row.version ?? "—"}
              </td>
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

  /* A non-fresh read above surviving rows: the table stays, the verdict shows. */
  .agent-issues__sync {
    border-bottom: 1px solid var(--border-subtle);
    color: var(--muted-foreground);
    font-size: 11px;
    margin: 0;
    padding: 6px 8px;
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
    border-collapse: separate;
    border-spacing: 0;
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
    box-shadow: inset 0 -1px 0 var(--border-subtle);
    height: 27px;
    line-height: 17px;
    max-width: 0;
    overflow: hidden;
    padding: 5px 8px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The pill keeps the overline 12px line height and its 2px padding, so its 18px
     box is 1px taller than the cell's 17px line box. The negative bottom margin
     removes that 1px from the line box, so the 27px row still comes from the cell.
     A block box lets the 86px state track ellipsize the longest badge ("implemented"). */
  .agent-issues-table .badge {
    display: inline-block;
    margin-bottom: -1px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: top;
  }

  /* Fixed tracks for category, filed, state, and version; the title takes the rest.
     The state track is the documented 86px and the badge ellipsizes inside it. */
  th:nth-child(2) {
    width: 110px;
  }
  th:nth-child(3) {
    width: 132px;
  }
  th:nth-child(4) {
    width: 86px;
  }
  th:nth-child(5) {
    width: 76px;
  }

  @media (max-width: 899px) {
    th:nth-child(2),
    td:nth-child(2),
    th:nth-child(3),
    td:nth-child(3),
    th:nth-child(5),
    td:nth-child(5) {
      display: none;
    }
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
