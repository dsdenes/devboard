<script lang="ts">
  import Tag from "lucide-svelte/icons/tag";
  import type { AgentReleaseRow } from "../types";

  interface Props {
    releases: AgentReleaseRow[];
  }

  let { releases }: Props = $props();

  /** A local clock reading; the raw ISO value stays in the cell tooltip. */
  function releasedLabel(value: string): string {
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

<div class="agent-releases" data-testid="agent-releases">
  {#if releases.length === 0}
    <div class="agent-releases__empty" data-testid="agent-releases-empty">
      <div class="agent-releases__empty-body">
        <span class="agent-releases__empty-icon" aria-hidden="true">
          <Tag size={20} strokeWidth={1.5} />
        </span>
        <p class="agent-releases__empty-title">No releases yet</p>
        <p class="agent-releases__empty-copy">
          The Release Train publishes one version here after it verifies a release.
        </p>
      </div>
    </div>
  {:else}
    <div class="table-wrap">
      <table class="agent-releases-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Version</th>
            <th scope="col" title="Non-merge commits in the released range">Commits</th>
          </tr>
        </thead>
        <tbody>
          {#each releases as release (release.version + release.at)}
            <tr
              data-testid="agent-release"
              data-version={release.version}
              data-commits={release.commits ?? ""}
            >
              <td class="mono">
                <time data-testid="agent-release-at" datetime={release.at} title={release.at}>
                  {releasedLabel(release.at)}
                </time>
              </td>
              <td class="mono agent-releases-table__version">
                {#if release.url === null}
                  <span data-testid="agent-release-version">{release.version}</span>
                {:else}
                  <a
                    data-testid="agent-release-version"
                    href={release.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={release.url}
                  >
                    {release.version}
                  </a>
                {/if}
              </td>
              <td class="mono" data-testid="agent-release-commits">{release.commits ?? "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .agent-releases {
    height: 100%;
    min-height: 0;
    overflow: auto;
  }

  .agent-releases__empty {
    align-items: center;
    display: flex;
    justify-content: center;
    min-height: 100%;
    padding: 24px 16px;
    text-align: center;
  }

  .agent-releases__empty-body {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 360px;
  }

  .agent-releases__empty-icon {
    color: var(--muted-foreground);
    display: flex;
    margin-bottom: 4px;
  }

  .agent-releases__empty-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    margin: 0;
  }

  .agent-releases__empty-copy {
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

  th:nth-child(2) {
    width: 140px;
  }
  th:nth-child(3) {
    width: 90px;
  }

  .agent-releases-table__version a {
    color: var(--foreground);
    text-decoration: none;
  }

  .agent-releases-table__version a:hover {
    color: var(--accent);
    text-decoration: underline;
  }
</style>
