<script lang="ts">
  import { connection } from "../connection.svelte";
  import { resources, type ResourceSettings } from "../resources.svelte";
  import CommandButton from "./CommandButton.svelte";
  import SaveFeedback from "./SaveFeedback.svelte";
  import Input from "./ui/input.svelte";
  import PageHeader from "./ui/page-header.svelte";

  /** The Save control whose confirmation this page renders. */
  const SCOPE = "resources.budget";

  const budget = $derived(resources.state);

  let maxAgentsText = $state("");
  let memoryHighText = $state("");
  let memoryMaxText = $state("");
  let reserveText = $state("");
  let error = $state<string | null>(null);

  // The page reads when it opens and after a reconnect; the server pushes a
  // frame after every save.
  $effect(() => {
    if (connection.open) resources.request();
  });

  // Each new frame reseeds the form from the effective values, so a save made
  // by another client lands here without a reload.
  $effect(() => {
    const current = resources.state;
    if (current === null) return;
    maxAgentsText = String(current.effective.maxAgentPeers);
    memoryHighText = String(current.effective.memoryHighMb);
    memoryMaxText = String(current.effective.memoryMaxMb);
    reserveText = String(current.effective.memoryReserveMb);
    error = null;
  });

  function whole(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    const value = Number(trimmed);
    return Number.isInteger(value) ? value : null;
  }

  function draft(): ResourceSettings | null {
    const maxAgentPeers = whole(maxAgentsText);
    const memoryHighMb = whole(memoryHighText);
    const memoryMaxMb = whole(memoryMaxText);
    const memoryReserveMb = whole(reserveText);
    if (
      maxAgentPeers === null ||
      memoryHighMb === null ||
      memoryMaxMb === null ||
      memoryReserveMb === null
    ) {
      return null;
    }
    return { maxAgentPeers, memoryHighMb, memoryMaxMb, memoryReserveMb };
  }

  // A malformed or partial draft counts as unsaved: the frame on screen is not
  // what the inputs would send.
  const dirty = $derived.by(() => {
    const current = budget?.effective;
    if (current === undefined) return false;
    const values = draft();
    if (values === null) return true;
    return (
      values.maxAgentPeers !== current.maxAgentPeers ||
      values.memoryHighMb !== current.memoryHighMb ||
      values.memoryMaxMb !== current.memoryMaxMb ||
      values.memoryReserveMb !== current.memoryReserveMb
    );
  });

  /** The bounds the server enforces; an invalid draft never leaves the page. */
  function save(): void {
    const values = draft();
    if (values === null) {
      error = "Every setting must be a whole number.";
      return;
    }
    if (values.maxAgentPeers < 1 || values.maxAgentPeers > 64) {
      error = "Max concurrent agents must be between 1 and 64.";
      return;
    }
    if (values.memoryMaxMb < 128) {
      error = "Memory max must be at least 128 MB.";
      return;
    }
    if (values.memoryHighMb < 64 || values.memoryHighMb > values.memoryMaxMb) {
      error = "Memory high must be at least 64 MB and at most memory max.";
      return;
    }
    if (values.memoryReserveMb < 64 || values.memoryReserveMb >= values.memoryMaxMb) {
      error = "Reserve must be at least 64 MB and below memory max.";
      return;
    }
    error = null;
    resources.save(values, SCOPE);
  }
</script>

<div class="mode-body" data-testid="resources-page">
  <PageHeader title="Resources" layout="bar" testid="devboard-header">
    {#snippet meta()}
      <span class="resources-meta" data-testid="resource-origin">
        {#if budget === null}
          Loading the resource budget…
        {:else if budget.saved === null}
          Derived defaults
        {:else}
          Saved settings
        {/if}
      </span>
    {/snippet}
  </PageHeader>

  <section class="panel resources-panel" aria-label="Resource budget">
    <div class="panel__header">
      <h2 class="panel__title">Budget</h2>
    </div>
    <div class="panel__body">
      <div class="resources-form" role="group" aria-label="Resource settings">
        <label class="resources-field">
          <span>Max agents</span>
          <Input
            type="number"
            min="1"
            max="64"
            step="1"
            inputmode="numeric"
            data-testid="resource-max-agents"
            value={maxAgentsText}
            oninput={(event) => {
              maxAgentsText = event.currentTarget.value;
              error = null;
            }}
          />
        </label>
        <label class="resources-field">
          <span>Memory high (MB)</span>
          <Input
            type="number"
            min="64"
            step="1"
            inputmode="numeric"
            data-testid="resource-memory-high"
            value={memoryHighText}
            oninput={(event) => {
              memoryHighText = event.currentTarget.value;
              error = null;
            }}
          />
        </label>
        <label class="resources-field">
          <span>Memory max (MB)</span>
          <Input
            type="number"
            min="128"
            step="1"
            inputmode="numeric"
            data-testid="resource-memory-max"
            value={memoryMaxText}
            oninput={(event) => {
              memoryMaxText = event.currentTarget.value;
              error = null;
            }}
          />
        </label>
        <label class="resources-field">
          <span>Reserve (MB)</span>
          <Input
            type="number"
            min="64"
            step="1"
            inputmode="numeric"
            data-testid="resource-reserve"
            value={reserveText}
            oninput={(event) => {
              reserveText = event.currentTarget.value;
              error = null;
            }}
          />
        </label>
      </div>

      {#if error !== null}
        <p class="issues-error" data-testid="resource-error" role="alert">{error}</p>
      {/if}

      {#if budget === null}
        <p class="resources-saved" data-testid="resource-saved">Waiting for the budget…</p>
      {:else if budget.saved !== null}
        <p class="resources-saved" data-testid="resource-saved">
          Saved: {budget.saved.maxAgentPeers} agents · high {budget.saved.memoryHighMb} MB · max
          {budget.saved.memoryMaxMb} MB · reserve {budget.saved.memoryReserveMb} MB
        </p>
      {:else}
        <p class="resources-saved" data-testid="resource-saved">No saved settings.</p>
      {/if}
    </div>
    <div class="panel__footer">
      {#if dirty}
        <span class="resources-dirty" data-testid="resource-unsaved">Unsaved changes</span>
      {/if}
      <CommandButton
        variant="secondary"
        label="Save"
        busyLabel="Saving…"
        evidence={() => resources.state}
        command={save}
        data-testid="resource-save"
        data-command="devboard.resources.save"
      >
        Save
      </CommandButton>
      <SaveFeedback scope={SCOPE} />
    </div>
  </section>

  <section class="panel resources-panel" aria-label="Live usage">
    <div class="panel__header">
      <h2 class="panel__title">Live usage</h2>
    </div>
    <div class="panel__body">
      {#if budget !== null}
        <dl class="resources-live">
          <div class="resources-live__row">
            <dt>Active agents</dt>
            <dd data-testid="resource-live-agents">{budget.live.activeAgents}</dd>
          </div>
          <div class="resources-live__row">
            <dt>Available</dt>
            <dd data-testid="resource-live-available">{budget.live.availableMb} MB</dd>
          </div>
          {#if budget.live.slicePresent}
            <div class="resources-live__row">
              <dt>Slice high</dt>
              <dd data-testid="resource-live-high">{budget.live.memoryHighMb} MB</dd>
            </div>
            <div class="resources-live__row">
              <dt>Slice max</dt>
              <dd data-testid="resource-live-max">{budget.live.memoryMaxMb} MB</dd>
            </div>
            <div class="resources-live__row">
              <dt>Slice current</dt>
              <dd data-testid="resource-live-current">{budget.live.memoryCurrentMb} MB</dd>
            </div>
          {/if}
        </dl>
      {:else}
        <p class="empty">Loading the live counters…</p>
      {/if}
    </div>
  </section>
</div>

<style>
  .resources-meta {
    color: var(--muted-foreground);
    font-size: 11px;
  }

  .resources-panel {
    flex: 0 0 auto;
  }

  .resources-form {
    display: grid;
    gap: 8px 10px;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  }

  .resources-field {
    color: var(--muted-foreground);
    display: flex;
    flex-direction: column;
    font-size: 11px;
    gap: 4px;
  }

  .resources-saved {
    color: var(--muted-foreground);
    font-size: 11px;
    margin: 8px 0 0;
  }

  .resources-panel :global(.issues-error) {
    margin-top: 8px;
  }

  .resources-dirty {
    color: var(--warning);
    font-size: 11px;
    margin-right: auto;
  }

  .resources-live {
    display: grid;
    gap: 6px;
    margin: 0;
  }

  .resources-live__row {
    display: flex;
    font-size: 12px;
    gap: 8px;
    justify-content: space-between;
  }

  .resources-live dt {
    color: var(--muted-foreground);
  }

  .resources-live dd {
    font-variant-numeric: tabular-nums;
    margin: 0;
  }
</style>
