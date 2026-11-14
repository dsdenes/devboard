<script lang="ts">
  import type { Snippet } from "svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  /**
   * The agent settings band every single-agent page renders inside the page
   * header footer, and the one `BarWithFooter` story renders with static
   * values: two overline groups under the header row. The page owns the field
   * text and passes its save controls, so the catalog and the product never
   * drift into two footers with different widths, input types, or clocks.
   */
  interface Props {
    /** The Every field's raw text; the page validates it as an integer. */
    cadenceText?: string;
    /** The Per hour field's raw text; empty is an unlimited limit. */
    maxPerHourText?: string;
    /** The Open issues field's raw text; empty is an unlimited limit. */
    maxPendingText?: string;
    lastRunAt?: string | null;
    nextRunAt?: string | null;
    /** The refusal the page holds for the Cadence group, if any. */
    cadenceError?: string | null;
    /** The refusal the page holds for the Filing limits group, if any. */
    limitsError?: string | null;
    /** The page's Save cadence control; the story renders a static one. */
    cadenceActions?: Snippet;
    /** The page's Save limits control; the story renders a static one. */
    limitsActions?: Snippet;
  }

  let {
    cadenceText = $bindable(""),
    maxPerHourText = $bindable(""),
    maxPendingText = $bindable(""),
    lastRunAt = null,
    nextRunAt = null,
    cadenceError = null,
    limitsError = null,
    cadenceActions,
    limitsActions,
  }: Props = $props();

  function stamp(value: string | null): string {
    if (value === null) return "never";
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

{#snippet defaultCadenceActions()}
  <Button variant="secondary">Save cadence</Button>
{/snippet}

{#snippet defaultLimitsActions()}
  <Button variant="secondary">Save limits</Button>
{/snippet}

<div class="agent-settings" role="group" aria-label="Cadence and filing limits">
  <div class="agent-settings__group" role="group" aria-label="Cadence">
    <span class="agent-settings__title">Cadence</span>
    <label class="agent-settings__field">
      <span>Every</span>
      <Input
        type="number"
        min="1"
        max="1440"
        step="1"
        inputmode="numeric"
        class="w-16 text-center"
        data-testid="agent-cadence"
        value={cadenceText}
        oninput={(event) => (cadenceText = event.currentTarget.value)}
      />
      <span class="agent-settings__unit">min</span>
    </label>
    <span class="agent-settings__run">
      Last run
      <span class="mono" data-testid="agent-last-run" title={lastRunAt ?? "never"}>
        {stamp(lastRunAt)}
      </span>
    </span>
    <span class="agent-settings__run">
      Next run
      <span class="mono" data-testid="agent-next-run" title={nextRunAt ?? "—"}>
        {stamp(nextRunAt)}
      </span>
    </span>
    {@render (cadenceActions ?? defaultCadenceActions)()}
    {#if cadenceError !== null}
      <p class="issues-error agent-settings__error" data-testid="agent-settings-error" role="alert">
        {cadenceError}
      </p>
    {/if}
  </div>
  <div class="agent-settings__group" role="group" aria-label="Filing limits">
    <span class="agent-settings__title">Filing limits</span>
    <!-- The raw text is the model: a number input reports "" for text it
         cannot represent, which would read as an unlimited limit. -->
    <label class="agent-settings__field">
      <span>Per hour</span>
      <Input
        type="text"
        inputmode="numeric"
        placeholder="unlimited"
        class="w-20 text-center"
        data-testid="agent-limit-hour"
        value={maxPerHourText}
        oninput={(event) => (maxPerHourText = event.currentTarget.value)}
      />
    </label>
    <label class="agent-settings__field">
      <span>Open issues</span>
      <Input
        type="text"
        inputmode="numeric"
        placeholder="unlimited"
        class="w-20 text-center"
        data-testid="agent-limit-pending"
        value={maxPendingText}
        oninput={(event) => (maxPendingText = event.currentTarget.value)}
      />
    </label>
    {@render (limitsActions ?? defaultLimitsActions)()}
    {#if limitsError !== null}
      <p class="issues-error agent-settings__error" data-testid="agent-settings-error" role="alert">
        {limitsError}
      </p>
    {/if}
  </div>
</div>

<style>
  /* Two overline groups, each ending in its own save control. */
  .agent-settings {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    width: 100%;
  }

  .agent-settings__group {
    align-items: center;
    column-gap: 10px;
    display: flex;
    flex-wrap: wrap;
    row-gap: 6px;
  }

  .agent-settings__title {
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .agent-settings__field {
    align-items: center;
    color: var(--muted-foreground);
    display: flex;
    font-size: 11px;
    gap: 4px;
    white-space: nowrap;
  }

  .agent-settings__unit,
  .agent-settings__run {
    color: var(--muted-foreground);
    font-size: 11px;
    white-space: nowrap;
  }

  /* The refusal wraps onto its own line under the fields it names. */
  .agent-settings__error {
    flex-basis: 100%;
    font-size: 11px;
  }

  .agent-settings__run {
    align-items: center;
    display: inline-flex;
    gap: 4px;
  }

  .agent-settings__run .mono {
    font-variant-numeric: tabular-nums;
  }
</style>
