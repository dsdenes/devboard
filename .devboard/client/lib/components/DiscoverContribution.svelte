<script lang="ts">
  import { relativeTime } from "../discover-format";
  import { discover } from "../discover.svelte";
  import type { ContributionFact } from "../types";

  const contribution = $derived(discover.contribution);
  const sections = $derived(contribution?.sections ?? []);
  const freshness = $derived(contribution?.freshness ?? discover.freshness);
  const discoveredLabel = $derived(
    freshness === null ? "" : relativeTime(freshness.discoveredAt),
  );

  const PERCENT_KEY = /(?:Share|Ratio|Usage)$/;

  function emptyText(fact: ContributionFact): string {
    if (fact.confidence === "unknown") return "Not recorded.";
    if (Array.isArray(fact.value) && fact.value.length === 0) return "None recorded.";
    return "None recorded.";
  }

  function scalar(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "yes" : "no";
    return "";
  }

  function percentText(fact: ContributionFact): string {
    return typeof fact.value === "number" ? `${fact.value}%` : "";
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function recordRows(value: Record<string, unknown>): Array<{ key: string; text: string }> {
    return Object.entries(value).map(([key, entry]) => ({
      key,
      text: `${key}: ${
        Array.isArray(entry)
          ? entry.map((item) => scalar(item) || JSON.stringify(item)).join(", ")
          : scalar(entry) || JSON.stringify(entry)
      }`,
    }));
  }

  function rowText(entry: Record<string, unknown>): string {
    if (typeof entry.path === "string" && typeof entry.count === "number") {
      return `${entry.path} (${entry.count})`;
    }
    return Object.entries(entry)
      .map(([key, value]) => `${key}: ${scalar(value) || JSON.stringify(value)}`)
      .join(" · ");
  }

  function itemText(entry: unknown): string {
    if (isRecord(entry)) return rowText(entry);
    return scalar(entry) || JSON.stringify(entry);
  }
</script>

<div
  class="scroll-column discover-page"
  data-testid="discover-panel"
  data-tab="contribution"
  data-contribution="true"
  aria-label="Discover contribution"
>
  <div data-testid="discover-contribution">
  <header class="discover-page__header">
    <div class="discover-page__heading">
      <h1 class="discover-page__title">Contribution</h1>
      <p class="discover-page__subtitle">
        How to contribute to this repository and how its accepted pull requests are written.
      </p>
    </div>
    {#if freshness !== null}
      <div class="discover-page__actions">
        <span class="muted" data-testid="discover-freshness" title={freshness.discoveredAt}>
          {discoveredLabel}
        </span>
      </div>
    {/if}
  </header>

  {#if contribution === null}
    <section class="panel">
      <div class="panel__body">
        <p class="empty" data-testid="discover-contribution-empty">
          No contribution sheet is published. Start the Contribution Agent to collect one.
        </p>
      </div>
    </section>
  {:else}
    {#each sections as section (section.id)}
      <section
        class="panel discover-card"
        data-testid="discover-contribution-section"
        data-section={section.id}
        aria-label={section.label}
      >
        <div class="panel__header">
          <h2 class="panel__title">{section.label}</h2>
        </div>
        <div class="panel__body">
          <dl class="discover-facts">
            {#each section.facts as fact (fact.key)}
              <div class="discover-fact" data-fact={fact.key}>
                <dt>{fact.label}</dt>
                <dd>
                  {#if fact.confidence === "unknown"}
                    <span class="muted">{emptyText(fact)}</span>
                  {:else if PERCENT_KEY.test(fact.key)}
                    <span>{percentText(fact)}</span>
                  {:else if isRecord(fact.value)}
                    <span class="discover-contribution-record">
                      {#each recordRows(fact.value) as row (row.key)}
                        <span class="discover-contribution-record__row">{row.text}</span>
                      {/each}
                    </span>
                  {:else if Array.isArray(fact.value)}
                    {#if fact.value.length === 0}
                      <span class="muted">{emptyText(fact)}</span>
                    {:else}
                      <ul class="discover-contribution-list">
                        {#each fact.value as entry, index (index)}
                          <li>{itemText(entry)}</li>
                        {/each}
                      </ul>
                    {/if}
                  {:else}
                    <span>{scalar(fact.value)}</span>
                  {/if}
                </dd>
              </div>
            {/each}
          </dl>
        </div>
      </section>
    {/each}
  {/if}
  </div>
</div>
