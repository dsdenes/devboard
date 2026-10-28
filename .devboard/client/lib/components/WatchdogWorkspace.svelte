<script lang="ts">
  import History from "lucide-svelte/icons/history";
  import Inbox from "lucide-svelte/icons/inbox";
  import { onMount } from "svelte";
  import type { BadgeTone } from "../record-status";
  import type { WatchdogCycle, WatchdogIssueState } from "../types";
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

  function clock(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleTimeString([], {
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

  /**
   * The window is the cycle's coverage, not a second start stamp: a same-day
   * window drops the repeated date, and a window that crosses midnight keeps
   * both dates.
   */
  function windowText(window: WatchdogCycle["window"]): string {
    if (window.start === null && window.end === null) return "—";
    if (window.start === null) return `never → ${stamp(window.end ?? "")}`;
    if (window.end === null) return `${stamp(window.start)} → never`;
    const start = new Date(window.start);
    const end = new Date(window.end);
    if (
      !Number.isNaN(start.getTime()) &&
      !Number.isNaN(end.getTime()) &&
      start.toDateString() === end.toDateString()
    ) {
      return `${clock(window.start)} → ${clock(window.end)}`;
    }
    return `${stamp(window.start)} → ${stamp(window.end)}`;
  }

  function actionTone(action: string): BadgeTone | undefined {
    if (action === "filed") return "success";
    if (action === "commented") return "accent";
    if (action === "failed") return "error";
    return undefined;
  }

  function stateTone(state: WatchdogIssueState | null): BadgeTone | undefined {
    if (state === "implemented") return "success";
    if (state === "pending") return "pending";
    return undefined;
  }
</script>

<section class="watchdog-page" data-testid="watchdog-page" aria-label="Watchdog">
  <PageHeader eyebrow="Issues" title="Watchdog" testid="watchdog-header">
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

  <section class="panel watchdog-latest" data-testid="watchdog-last-cycle" aria-label="Newest cycle">
    <div class="panel__header">
      <h2 class="panel__title">Newest cycle</h2>
      <span class="panel__subtitle" data-testid="watchdog-last-age">{age(cycle)}</span>
    </div>
    <div class="panel__body watchdog-latest__body">
      <div class="watchdog-latest__verdict">
        <span
          class="badge"
          data-tone={actionTone(snapshot?.action ?? "")}
          data-testid="watchdog-last-action"
        >
          {snapshot?.action ?? "unknown"}
        </span>
        {#if snapshot?.reason !== undefined}
          <p class="watchdog-latest__reason" data-testid="watchdog-last-reason">{snapshot.reason}</p>
        {:else if cycle === null}
          <p class="watchdog-latest__reason watchdog-latest__reason--empty">No cycle has run yet.</p>
        {/if}
      </div>
      <dl class="watchdog-latest__facts">
        <div>
          <dt>Started</dt>
          <dd class="mono" data-testid="watchdog-last-cycle-at">
            {#if cycle === null}
              never
            {:else}
              <time datetime={cycle}>{stamp(cycle)}</time>
            {/if}
          </dd>
        </div>
        <div>
          <dt>Findings</dt>
          <dd class="mono" data-testid="watchdog-last-findings">{snapshot?.findings ?? 0}</dd>
        </div>
        <div>
          <dt>Pending filings</dt>
          <dd class="mono" data-testid="watchdog-last-pending">{snapshot?.pending ?? 0}</dd>
        </div>
      </dl>
    </div>
  </section>

  <div class="watchdog-body">
    <section class="panel watchdog-panel" aria-label="Filed issues">
      <div class="panel__header">
        <h2 class="panel__title">Filed issues</h2>
        <span class="panel__subtitle" data-testid="watchdog-issues-count">
          {issues.length} filed · {snapshot?.pending ?? 0} pending filing
        </span>
      </div>
      <div class="panel__body panel__body--flush" data-testid="watchdog-issues">
        {#if issues.length === 0}
          <div class="watchdog-empty" data-testid="watchdog-issues-empty">
            <span class="watchdog-empty__icon" aria-hidden="true">
              <Inbox size={20} strokeWidth={1.5} />
            </span>
            <p class="watchdog-empty__title">No issues filed</p>
            <p class="watchdog-empty__copy">
              Findings worth an issue appear here after a cycle.
            </p>
          </div>
        {:else}
          <table class="watchdog-table watchdog-table--issues">
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
                <tr
                  class="watchdog-issue"
                  data-testid="watchdog-issue"
                  data-url={issue.url}
                  data-state={issue.state ?? "unknown"}
                  data-version={issue.version ?? ""}
                >
                  <td class="watchdog-table__title">
                    <a
                      class="watchdog-issue__title"
                      data-testid="watchdog-issue-title"
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`[watchdog] ${issue.category}: ${issue.line}`}
                    >
                      [watchdog] {issue.category}: {issue.line}
                    </a>
                  </td>
                  <td class="mono watchdog-table__muted" data-testid="watchdog-issue-category">
                    {issue.category}
                  </td>
                  <td class="mono">
                    <time data-testid="watchdog-issue-filed" datetime={issue.filedAt}>
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
                  <td class="mono watchdog-table__muted" data-testid="watchdog-issue-version">
                    {issue.version ?? "—"}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </section>

    <section class="panel watchdog-panel" aria-label="Cycle history">
      <div class="panel__header">
        <h2 class="panel__title">Cycle history</h2>
        <span class="panel__subtitle">Newest first · {cycles.length} retained</span>
      </div>
      <div class="panel__body panel__body--flush" data-testid="watchdog-cycles">
        {#if cycles.length === 0}
          <div class="watchdog-empty" data-testid="watchdog-cycles-empty">
            <span class="watchdog-empty__icon" aria-hidden="true">
              <History size={20} strokeWidth={1.5} />
            </span>
            <p class="watchdog-empty__title">No cycles yet</p>
            <p class="watchdog-empty__copy">The watchdog records one cycle every ten minutes.</p>
          </div>
        {:else}
          <table class="watchdog-table watchdog-table--cycles">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Window</th>
                <th scope="col">Action</th>
                <th scope="col">Findings</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {#each cycles as entry, index (index)}
                <tr
                  class="watchdog-cycle"
                  data-testid="watchdog-cycle"
                  data-action={entry.action}
                  aria-label={`${entry.action} cycle at ${entry.at}`}
                >
                  <td>
                    <span class="mono" data-testid="watchdog-cycle-at">
                      <time datetime={entry.at}>{stamp(entry.at)}</time>
                    </span>
                  </td>
                  <td class="mono watchdog-table__muted" data-testid="watchdog-cycle-window">
                    {windowText(entry.window)}
                  </td>
                  <td>
                    <span
                      class="badge"
                      data-tone={actionTone(entry.action)}
                      data-testid="watchdog-cycle-action"
                    >
                      {entry.action}
                    </span>
                  </td>
                  <td class="mono watchdog-cycle__findings" data-testid="watchdog-cycle-findings">
                    {entry.findings}
                  </td>
                  <td
                    class="watchdog-table__muted watchdog-cycle__reason"
                    data-testid="watchdog-cycle-reason"
                    title={entry.reason ?? ""}
                  >
                    {entry.reason ?? ""}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </section>
  </div>
</section>

<style>
  .watchdog-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    padding: 16px;
  }

  .watchdog-page__alerts {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 6px;
  }

  .watchdog-latest {
    flex: 0 0 auto;
  }

  .watchdog-latest__body {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    justify-content: space-between;
  }

  .watchdog-latest__verdict {
    align-items: center;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .watchdog-latest__reason {
    color: var(--foreground);
    font-size: 12px;
    line-height: 1.4;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .watchdog-latest__reason--empty {
    color: var(--muted-foreground);
  }

  .watchdog-latest__facts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 24px;
    margin: 0;
  }

  .watchdog-latest__facts > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .watchdog-latest__facts dt {
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .watchdog-latest__facts dd {
    font-size: 11.5px;
    line-height: 1.4;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .watchdog-body {
    display: grid;
    flex: 1;
    gap: 12px;
    grid-template-columns: minmax(0, 1.25fr) minmax(420px, 1fr);
    min-height: 0;
    min-width: 0;
  }

  .watchdog-panel {
    min-height: 0;
  }

  .watchdog-table {
    border-collapse: collapse;
    font-size: 12px;
    table-layout: fixed;
    width: 100%;
  }

  .watchdog-table th {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    position: sticky;
    text-align: left;
    text-transform: uppercase;
    top: 0;
    z-index: 1;
  }

  .watchdog-table td {
    border-bottom: 1px solid var(--border-subtle);
    height: 27px;
    line-height: 26px;
    max-width: 0;
    overflow: hidden;
    padding: 0 8px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .watchdog-table tbody tr:hover {
    background: var(--row-hover);
  }

  .watchdog-table tbody tr:last-child td {
    border-bottom: 0;
  }

  .watchdog-table__muted {
    color: var(--muted-foreground);
  }

  .watchdog-table--issues th:nth-child(2) {
    width: 104px;
  }
  .watchdog-table--issues th:nth-child(3) {
    width: 142px;
  }
  .watchdog-table--issues th:nth-child(4) {
    width: 104px;
  }
  .watchdog-table--issues th:nth-child(5) {
    width: 74px;
  }

  .watchdog-table--cycles th:nth-child(1) {
    width: 140px;
  }
  .watchdog-table--cycles th:nth-child(2) {
    width: 160px;
  }
  .watchdog-table--cycles th:nth-child(3) {
    width: 100px;
  }
  .watchdog-table--cycles th:nth-child(4) {
    width: 70px;
  }

  .watchdog-issue__title {
    color: var(--foreground);
    text-decoration: none;
  }

  .watchdog-issue__title:hover,
  .watchdog-issue__title:focus-visible {
    color: var(--accent);
    text-decoration: underline;
  }

  .watchdog-empty {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
    justify-content: center;
    min-height: 100%;
    padding: 24px 16px;
    text-align: center;
  }

  .watchdog-empty__icon {
    color: var(--muted-foreground);
    display: flex;
    margin-bottom: 4px;
  }

  .watchdog-empty__title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    margin: 0;
  }

  .watchdog-empty__copy {
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
    max-width: 360px;
  }

  @media (max-width: 1500px) {
    .watchdog-body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1.15fr) minmax(0, 1fr);
    }
  }

  /* The category is already in the issue title and the window is the audit
     detail behind the start stamp; both yield before the content does. */
  @media (max-width: 1100px) {
    .watchdog-table--issues th:nth-child(2),
    .watchdog-table--issues td:nth-child(2),
    .watchdog-table--cycles th:nth-child(2),
    .watchdog-table--cycles td:nth-child(2) {
      display: none;
    }
  }
</style>
