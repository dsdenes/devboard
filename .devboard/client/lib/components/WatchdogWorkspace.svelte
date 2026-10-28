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

  <section class="panel" data-testid="watchdog-last-cycle" aria-label="Newest cycle">
    <div class="panel__header">
      <h2 class="panel__title">Newest cycle</h2>
      <span class="panel__subtitle mono" data-testid="watchdog-last-age">{age(cycle)}</span>
    </div>
    <div class="panel__body stack-sm">
      <dl class="watchdog-facts">
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
          <dt>Action</dt>
          <dd class="mono" data-testid="watchdog-last-action">{snapshot?.action ?? "unknown"}</dd>
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
      {#if snapshot?.reason !== undefined}
        <p class="watchdog-reason" data-testid="watchdog-last-reason">{snapshot.reason}</p>
      {/if}
    </div>
  </section>

  <section class="panel" aria-label="Cycle history">
    <div class="panel__header">
      <h2 class="panel__title">Cycle history</h2>
      <span class="panel__subtitle">Newest first · at most 100 retained cycles</span>
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
            <span class="mono watchdog-cycle__at" data-testid="watchdog-cycle-at">
              <time datetime={entry.at}>{stamp(entry.at)}</time>
            </span>
            <span class="badge" data-tone={actionTone(entry.action)} data-testid="watchdog-cycle-action">
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

  <section class="panel" aria-label="Filed issues">
    <div class="panel__header">
      <h2 class="panel__title">Filed issues</h2>
      <span class="panel__subtitle" data-testid="watchdog-issues-count">
        {issues.length} filed · {snapshot?.pending ?? 0} pending filing
      </span>
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
                    >
                      [watchdog] {issue.category}: {issue.line}
                    </a>
                  </td>
                  <td class="mono" data-testid="watchdog-issue-category">{issue.category}</td>
                  <td>
                    <time class="mono" data-testid="watchdog-issue-filed" datetime={issue.filedAt}>
                      {stamp(issue.filedAt)}
                    </time>
                  </td>
                  <td>
                    <span class="badge" data-tone={stateTone(issue.state)} data-testid="watchdog-issue-state">
                      {issue.state ?? "unknown"}
                    </span>
                  </td>
                  <td class="mono" data-testid="watchdog-issue-version">{issue.version ?? "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>
  </section>
</section>

<style>
  .watchdog-page {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 10px;
  }

  .watchdog-page__alerts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .watchdog-facts {
    display: grid;
    gap: 6px 18px;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    margin: 0;
  }

  .watchdog-facts div {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .watchdog-facts dt {
    color: var(--muted-foreground);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .watchdog-facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .watchdog-reason {
    color: var(--muted-foreground);
    margin: 0;
  }

  .watchdog-empty {
    color: var(--muted-foreground);
    margin: 0;
    padding: 10px 12px;
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
    border-bottom: 1px solid var(--border);
    display: grid;
    font-size: 11px;
    gap: 10px;
    grid-template-columns: 150px 90px minmax(0, auto);
    padding: 5px 12px;
  }

  .watchdog-cycle:last-child {
    border-bottom: 0;
  }

  .watchdog-cycle__issues {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .watchdog-cycle__issue {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .watchdog-issues {
    overflow: auto;
  }

  .watchdog-table {
    border-collapse: collapse;
    font-size: 11px;
    width: 100%;
  }

  .watchdog-table th,
  .watchdog-table td {
    border-bottom: 1px solid var(--border);
    padding: 5px 12px;
    text-align: left;
    vertical-align: top;
  }

  .watchdog-table th {
    color: var(--muted-foreground);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .watchdog-table tr:last-child td {
    border-bottom: 0;
  }

  .watchdog-issue__title {
    color: var(--foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
  }
</style>
