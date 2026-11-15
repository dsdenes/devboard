<script lang="ts">
  import History from "lucide-svelte/icons/history";
  import { statusTone } from "../status-tone";
  import type { AgentDeployRow } from "../types";

  interface Props {
    deploys: AgentDeployRow[];
  }

  let { deploys }: Props = $props();

  /** The run's completion, or its start while it still runs. */
  function runInstant(row: AgentDeployRow): string | null {
    return row.endedAt ?? row.startedAt;
  }

  /** A local clock reading; the raw ISO value stays in the cell tooltip. */
  function runLabel(value: string): string {
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
</script>

<div class="agent-deploys" data-testid="agent-deploys">
  {#if deploys.length === 0}
    <div class="agent-deploys__empty" data-testid="agent-deploys-empty">
      <div class="agent-deploys__empty-body">
        <span class="agent-deploys__empty-icon" aria-hidden="true">
          <History size={20} strokeWidth={1.5} />
        </span>
        <p class="agent-deploys__empty-title">No deploys yet</p>
        <p class="agent-deploys__empty-copy">
          Each advance of main records one row here after the deploy finishes.
        </p>
      </div>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="agent-deploys-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Result</th>
            <th scope="col" title="Non-merge commits since the previous successful deploy">
              Commits
            </th>
          </tr>
        </thead>
        <tbody>
          {#each deploys as deploy (deploy.id)}
            {@const instant = runInstant(deploy)}
            <tr
              data-testid="agent-deploy"
              data-state={deploy.state}
              data-commit={deploy.commit}
              data-commits={deploy.commits ?? ""}
            >
              <td class="mono" data-testid="agent-deploy-date">
                {#if instant !== null}
                  <time data-testid="agent-deploy-at" datetime={instant} title={instant}>
                    {runLabel(instant)}
                  </time>
                {:else}
                  —
                {/if}
              </td>
              <td>
                <span
                  class="badge"
                  data-tone={statusTone(deploy.state)}
                  data-testid="agent-deploy-state"
                >
                  {deploy.state}
                </span>
              </td>
              <td class="mono" data-testid="agent-deploy-commits">
                {deploy.commits ?? "—"}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .agent-deploys {
    height: 100%;
    min-height: 0;
    overflow: auto;
  }

  .agent-deploys__empty {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 100%;
    padding: 24px 16px;
    text-align: center;
  }

  .agent-deploys__empty-body {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 360px;
  }

  .agent-deploys__empty-icon {
    color: var(--muted-foreground);
    display: flex;
    margin-bottom: 4px;
  }

  .agent-deploys__empty-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    margin: 0;
  }

  .agent-deploys__empty-copy {
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

  th:nth-child(1) {
    width: 170px;
  }
  th:nth-child(2) {
    width: 110px;
  }
  th:nth-child(3) {
    width: 90px;
  }
</style>
