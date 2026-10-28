<script lang="ts">
  import { onMount } from "svelte";
  import type { BadgeTone } from "../record-status";
  import type { WatchdogIssueState } from "../types";
  import { watchdog } from "../watchdog.svelte";
  import PageHeader from "./ui/page-header.svelte";

  const snapshot = $derived(watchdog.snapshot);
  const sync = $derived(watchdog.sync);
  const syncTone = $derived<BadgeTone>(
    sync.state === "ok" ? "success" : sync.state === "error" ? "error" : "stale",
  );
  const cycle = $derived(snapshot?.cycle ?? null);
  const cycles = $derived(snapshot?.cycles ?? []);
  const issues = $derived(snapshot?.issues ?? []);

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  onMount(() => {
    watchdog.start();
    return () => watchdog.stop();
  });

  function stamp(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function age(value: string | null): string {
    if (value === null) return "never";
    const elapsed = now - Date.parse(value);
    if (!Number.isFinite(elapsed)) return "unknown";
    const seconds = Math.max(0, Math.floor(elapsed / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function actionTone(action: string): BadgeTone | undefined {
    return action === "failed" ? "error" : action === "none" ? undefined : "accent";
  }

  function stateTone(state: WatchdogIssueState | null): BadgeTone | undefined {
    if (state === "implemented") return "success";
    if (state === "pending") return "pending";
    return undefined;
  }
</script>

<section class="watchdog-page" data-testid="watchdog-page" aria-label="Watchdog">
  <PageHeader
    title="Watchdog"
    subtitle="Files significant repository findings as issues and tracks their resolution."
    testid="watchdog-header"
  >
    {#snippet meta()}
      <span class="badge" data-tone={syncTone} data-testid="watchdog-sync" data-state={sync.state}>
        GitHub read {sync.state}
      </span>
      <span class="watchdog-sync-at muted">
        Last read
        <span class="mono" data-testid="watchdog-sync-at" title={sync.at ?? "never"}>
          {#if sync.at === null}
            never
          {:else}
            <time datetime={sync.at}>{stamp(sync.at)}</time>
          {/if}
        </span>
      </span>
    {/snippet}
  </PageHeader>

  {#if sync.error !== null || watchdog.error !== null}
    <div class="watchdog-page__alerts">
      {#if sync.error !== null}
        <p class="issues-error" data-testid="watchdog-sync-error" role="alert">{sync.error}</p>
      {/if}
      {#if watchdog.error !== null}
        <p class="issues-error" data-testid="watchdog-error" role="alert">{watchdog.error}</p>
      {/if}
    </div>
  {/if}

  <div class="watchdog-body">
    <div class="watchdog-main">
      <section class="panel" data-testid="watchdog-last-cycle" aria-label="Newest cycle">
        <div class="panel__header">
          <h2 class="panel__title">Newest cycle</h2>
          <span class="watchdog-panel__trail">
            <span
              class="badge"
              data-tone={actionTone(snapshot?.action ?? "none")}
              data-testid="watchdog-last-action"
            >
              {snapshot?.action ?? "none"}
            </span>
            <span class="panel__subtitle mono" data-testid="watchdog-last-age">{age(cycle)}</span>
          </span>
        </div>
        <div class="panel__body watchdog-summary">
          <dl class="watchdog-facts">
            <div>
              <dt>Started</dt>
              <dd data-testid="watchdog-last-cycle-at">
                {#if cycle === null}
                  never
                {:else}
                  <time datetime={cycle}>{stamp(cycle)}</time>
                {/if}
              </dd>
            </div>
            <div>
              <dt>Findings</dt>
              <dd data-testid="watchdog-last-findings">{snapshot?.findings ?? 0}</dd>
            </div>
            <div data-warning={(snapshot?.pending ?? 0) > 0 ? "" : undefined}>
              <dt>Pending filings</dt>
              <dd data-testid="watchdog-last-pending">{snapshot?.pending ?? 0}</dd>
            </div>
          </dl>
          {#if snapshot?.reason !== undefined}
            <p class="watchdog-reason" data-testid="watchdog-last-reason">{snapshot.reason}</p>
          {/if}
        </div>
      </section>

      <section class="panel watchdog-filed" aria-label="Filed issues">
        <div class="panel__header">
          <h2 class="panel__title">Filed issues</h2>
          <span class="panel__subtitle" data-testid="watchdog-issues-count">{issues.length} filed</span>
        </div>
        <div class="panel__body panel__body--flush">
          <div class="watchdog-issues" data-testid="watchdog-issues">
            {#if issues.length === 0}
              <p class="watchdog-empty" data-testid="watchdog-issues-empty">No issue has been filed.</p>
            {:else}
              <table class="watchdog-table">
                <thead>
                  <tr>
                    <th scope="col">Issue</th>
                    <th scope="col">Category</th>
                    <th scope="col">Filed</th>
                    <th scope="col">State</th>
                    <th scope="col">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {#each issues as issue (issue.url)}
                    {@const title = `[watchdog] ${issue.category}: ${issue.line}`}
                    <tr
                      class="watchdog-issue"
                      data-testid="watchdog-issue"
                      data-url={issue.url}
                      data-state={issue.state ?? "unknown"}
                      data-version={issue.version ?? ""}
                    >
                      <td>
                        <a
                          class="watchdog-issue__title"
                          data-testid="watchdog-issue-title"
                          href={issue.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={title}
                        >
                          {title}
                        </a>
                      </td>
                      <td class="watchdog-issue__category" data-testid="watchdog-issue-category">
                        {issue.category}
                      </td>
                      <td>
                        <time
                          class="watchdog-issue__filed"
                          data-testid="watchdog-issue-filed"
                          datetime={issue.filedAt}
                        >
                          {stamp(issue.filedAt)}
                        </time>
                      </td>
                      <td>
                        <span
                          class="badge"
                          data-tone={stateTone(issue.state)}
                          data-testid="watchdog-issue-state"
                        >
                          {issue.state ?? "unknown"}
                        </span>
                      </td>
                      <td class="watchdog-issue__version" data-testid="watchdog-issue-version">
                        {issue.version ?? "—"}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
        </div>
      </section>
    </div>

    <section class="panel watchdog-history" aria-label="Cycle history">
      <div class="panel__header">
        <h2 class="panel__title">Cycle history</h2>
      </div>
      <div class="panel__body panel__body--flush">
        <ol class="watchdog-cycles" data-testid="watchdog-cycles">
          {#each cycles as entry, index (index)}
            <li
              class="watchdog-cycle"
              data-testid="watchdog-cycle"
              data-action={entry.action}
              aria-label={`${entry.action} cycle at ${entry.at}`}
            >
              <span class="watchdog-cycle__at" data-testid="watchdog-cycle-at">
                <time datetime={entry.at}>{stamp(entry.at)}</time>
              </span>
              <span
                class="badge watchdog-cycle__action"
                data-tone={actionTone(entry.action)}
                data-testid="watchdog-cycle-action"
              >
                {entry.action}
              </span>
              {#if entry.issues.length > 0}
                <span class="watchdog-cycle__issues" data-testid="watchdog-cycle-issues">
                  {#each entry.issues as issue (issue)}
                    {@const number = issue.slice(issue.lastIndexOf("/") + 1)}
                    <a
                      class="watchdog-cycle__issue"
                      data-testid="watchdog-cycle-issue"
                      href={issue}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={issue}
                      aria-label={`GitHub issue ${number.length > 0 ? number : issue}`}
                    >
                      {number.length > 0 ? `#${number}` : issue}
                    </a>
                  {/each}
                </span>
              {/if}
            </li>
          {:else}
            <li class="watchdog-empty" data-testid="watchdog-cycles-empty">No cycle has run yet.</li>
          {/each}
        </ol>
      </div>
    </section>
  </div>
</section>

<style>
  .watchdog-page {
    container-name: watchdog;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 16px;
  }

  .watchdog-page__alerts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .watchdog-body {
    align-items: stretch;
    display: grid;
    flex: 1 1 auto;
    gap: 12px;
    grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.9fr);
    min-height: 0;
  }

  .watchdog-main {
    container-name: watchdog-main;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    min-width: 0;
  }

  .watchdog-panel__trail {
    align-items: center;
    display: inline-flex;
    flex: 0 0 auto;
    gap: 8px;
  }

  .watchdog-summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .watchdog-facts {
    display: grid;
    gap: 0;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    margin: 0;
  }

  .watchdog-facts div {
    border-left: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 0 10px;
  }

  .watchdog-facts div:first-child {
    border-left: 0;
    padding-left: 0;
  }

  .watchdog-facts dt {
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .watchdog-facts dd {
    font-family: var(--font-mono);
    font-size: 12px;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .watchdog-facts div[data-warning] dd {
    color: var(--warning);
  }

  .watchdog-reason {
    border-top: 1px solid var(--border-subtle);
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
    overflow-wrap: anywhere;
    padding-top: 8px;
  }

  .watchdog-empty {
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
    padding: 10px 12px;
  }

  .watchdog-filed {
    flex: 1 1 auto;
  }

  .watchdog-cycles {
    display: flex;
    flex-direction: column;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .watchdog-cycle {
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    display: grid;
    font-size: 12px;
    gap: 8px;
    grid-template-columns: 118px 86px minmax(0, 1fr);
    min-height: 27px;
    padding: 5px 10px;
  }

  .watchdog-cycle:last-child {
    border-bottom: 0;
  }

  .watchdog-cycle__at {
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .watchdog-cycle__action {
    justify-self: start;
  }

  .watchdog-cycle__issues {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .watchdog-cycle__issue {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-decoration: none;
  }

  .watchdog-cycle__issue:hover,
  .watchdog-cycle__issue:focus-visible {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .watchdog-table {
    border-collapse: collapse;
    font-size: 12px;
    table-layout: fixed;
    width: 100%;
  }

  .watchdog-table th:nth-child(2) {
    width: 110px;
  }

  .watchdog-table th:nth-child(3) {
    width: 132px;
  }

  .watchdog-table th:nth-child(4) {
    width: 86px;
  }

  .watchdog-table th:nth-child(5) {
    width: 76px;
  }

  .watchdog-table th {
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

  .watchdog-table td {
    border-bottom: 1px solid var(--border-subtle);
    padding: 5px 8px;
    text-align: left;
    vertical-align: middle;
  }

  .watchdog-table tr:last-child td {
    border-bottom: 0;
  }

  .watchdog-table tbody tr:hover {
    background: var(--row-hover);
  }

  .watchdog-table td:first-child {
    overflow: hidden;
  }

  .watchdog-issue__title {
    color: var(--foreground);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .watchdog-issue__title:hover,
  .watchdog-issue__title:focus-visible {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .watchdog-issue__category,
  .watchdog-issue__filed,
  .watchdog-issue__version {
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .watchdog-issue__version {
    color: var(--foreground);
  }

  @container watchdog (max-width: 1300px) {
    .watchdog-body {
      align-items: start;
      flex: 0 0 auto;
      grid-template-columns: minmax(0, 1fr);
    }

    .watchdog-filed {
      flex: 0 0 auto;
      max-height: clamp(240px, 48vh, 520px);
    }

    .watchdog-history {
      max-height: clamp(280px, 58vh, 580px);
    }
  }

  @container watchdog-main (max-width: 900px) {
    /* The title carries the category and finding; the narrow table keeps the
       identification and the state, and drops the secondary columns. */
    .watchdog-table th:nth-child(2),
    .watchdog-table td:nth-child(2),
    .watchdog-table th:nth-child(3),
    .watchdog-table td:nth-child(3),
    .watchdog-table th:nth-child(5),
    .watchdog-table td:nth-child(5) {
      display: none;
    }
  }
</style>
