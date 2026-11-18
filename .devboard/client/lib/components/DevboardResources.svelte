<script lang="ts">
  import { resources, type ResourceSettings } from "../resources.svelte";
  import { connection } from "../connection.svelte";
  import CommandButton from "./CommandButton.svelte";
  import SaveFeedback from "./SaveFeedback.svelte";
  import Input from "./ui/input.svelte";
  import PageHeader from "./ui/page-header.svelte";

  /** The Save control whose confirmation this page renders. */
  const SCOPE = "resources.budget";

  const budget = $derived(resources.state);
  /** True until a frame reports unreadable host memory; the form loads enabled. */
  const memoryAvailable = $derived(budget === null || budget.effective.memoryMaxMb !== null);

  let maxAgentsText = $state("");
  let memoryHighText = $state("");
  let memoryMaxText = $state("");
  let reserveText = $state("");
  let error = $state<string | null>(null);
  /**
   * The paragraph's text: this page's own validation first, then the server's
   * refusal of the last save, which no local check can predict.
   */
  const alertMessage = $derived(error ?? resources.refusal);

  /** The effective values the inputs were last seeded from. */
  let seeded: ResourceSettings | null = null;

  /** True when a frame repeats the budget the inputs were seeded from. */
  function sameBudget(left: ResourceSettings, right: ResourceSettings): boolean {
    return (
      left.maxAgentPeers === right.maxAgentPeers &&
      left.memoryHighMb === right.memoryHighMb &&
      left.memoryMaxMb === right.memoryMaxMb &&
      left.memoryReserveMb === right.memoryReserveMb
    );
  }

  // A changed budget reseeds the form, so a save made by another client lands
  // here without a reload. The page polls `/resources` once a second and every
  // poll carries a fresh live section; reseeding on a repeated budget would
  // erase an edit in progress, so only a different budget touches the inputs.
  $effect(() => {
    const current = resources.state;
    if (current === null) return;
    if (seeded !== null && sameBudget(seeded, current.effective)) return;
    seeded = current.effective;
    maxAgentsText = String(current.effective.maxAgentPeers);
    memoryHighText =
      current.effective.memoryHighMb === null ? "" : String(current.effective.memoryHighMb);
    memoryMaxText =
      current.effective.memoryMaxMb === null ? "" : String(current.effective.memoryMaxMb);
    reserveText =
      current.effective.memoryReserveMb === null ? "" : String(current.effective.memoryReserveMb);
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
    if (maxAgentPeers === null) return null;
    // A host whose memory total could not be read has no memory mark to send:
    // the cap is the whole budget this page can save, and the server keeps the
    // slice unchanged.
    if (!memoryAvailable) {
      return { maxAgentPeers, memoryHighMb: null, memoryMaxMb: null, memoryReserveMb: null };
    }
    const memoryHighMb = whole(memoryHighText);
    const memoryMaxMb = whole(memoryMaxText);
    const memoryReserveMb = whole(reserveText);
    if (memoryHighMb === null || memoryMaxMb === null || memoryReserveMb === null) {
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

  /**
   * Sends the draft. The bounds have one owner, the server: a value it refuses
   * comes back as its refusal, so the page never refuses a budget the server
   * would accept. Only a draft that names no budget at all stays here, because
   * it is not a budget to send.
   */
  function save(): void {
    const values = draft();
    if (values === null) {
      error = "Every setting must be a whole number.";
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
        {:else if budget.settingsError !== null}
          <span class="resources-meta__error" title={budget.settingsError}>
            {budget.settingsError}
          </span>
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
            disabled={!memoryAvailable}
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
            disabled={!memoryAvailable}
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
            disabled={!memoryAvailable}
            oninput={(event) => {
              reserveText = event.currentTarget.value;
              error = null;
            }}
          />
        </label>
      </div>

      {#if budget?.memoryError}
        <p
          class="resources-saved resources-meta__error"
          data-testid="resource-memory-unavailable"
          title={budget.memoryError}
        >
          Memory unavailable: {budget.memoryError}
        </p>
      {/if}

      {#if alertMessage !== null}
        <p class="issues-error" data-testid="resource-error" role="alert">{alertMessage}</p>
      {/if}

      {#if budget === null}
        <p class="resources-saved" data-testid="resource-saved">Waiting for the budget…</p>
      {:else if budget.saved !== null}
        <p class="resources-saved" data-testid="resource-saved">
          Saved: {budget.saved.maxAgentPeers} agents
          {#if budget.saved.memoryMaxMb !== null}
            · high {budget.saved.memoryHighMb} MB · max {budget.saved.memoryMaxMb} MB · reserve
            {budget.saved.memoryReserveMb} MB
          {/if}
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
        evidence={() => resources.confirmed}
        refusal={() => connection.refusalRevision("setResources")}
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
            <dt>Exempt agents</dt>
            <dd data-testid="resource-live-exempt-agents">{budget.live.exemptAgents}</dd>
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

  .resources-meta__error {
    color: var(--destructive);
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
