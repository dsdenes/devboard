<script lang="ts">
  import { Dialog } from "bits-ui";
  import { createCommandBusy } from "../command-busy.svelte";
  import { percentText, statusText } from "../provider-label";
  import { providers } from "../providers.svelte";
  import { PROVIDERS } from "../../../lib/provider-catalog.ts";
  import type { ProviderId, ProviderSubscription } from "../types";
  import CommandButton from "./CommandButton.svelte";
  import CommandNotice from "./CommandNotice.svelte";
  import SaveFeedback from "./SaveFeedback.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  let provider = $state<ProviderId>("opencode-go");
  let label = $state("");
  let key = $state("");
  let editing = $state<ProviderSubscription | null>(null);
  let pendingDelete = $state<string | null>(null);
  /** The save request this form is waiting on, by id. */
  let saving = $state<number | null>(null);

  /**
   * Counts each settled provider change, success or failure. The store's
   * `busy` flag flips on send and clears on the answer, so a transition from
   * busy to idle is the confirmation every change kind reports.
   */
  let changeSeq = $state(0);
  let wasBusy = false;
  $effect(() => {
    const busy = providers.busy;
    if (wasBusy && !busy) changeSeq += 1;
    wasBusy = busy;
  });

  // The form button submits, so the dispatch happens in the submit handler and
  // this helper owns its in-flight label instead of a CommandButton.
  const savePending = createCommandBusy({
    label: () => (editing === null ? "Add key" : "Save changes"),
    evidence: () => changeSeq,
  });

  function resetForm(): void {
    editing = null;
    provider = "opencode-go";
    label = "";
    key = "";
  }

  function startEdit(subscription: ProviderSubscription): void {
    editing = subscription;
    provider = subscription.provider;
    label = subscription.label;
    key = "";
  }

  function save(): void {
    if (editing === null && key.trim().length === 0) return;
    savePending.start();
    saving = providers.save({
      ...(editing === null ? {} : { id: editing.id }),
      provider,
      label: label.trim().length === 0 ? providersProviderName(provider) : label.trim(),
      ...(key.trim().length === 0 ? {} : { key: key.trim() }),
    });
  }

  function providersProviderName(id: ProviderId): string {
    return id === "opencode-go" ? "OpenCode Go" : "OpenRouter";
  }

  function confirmDelete(): void {
    const id = pendingDelete;
    if (id === null) return;
    providers.remove(id);
    pendingDelete = null;
    if (editing?.id === id) resetForm();
  }

  function checkedAt(value: string | null): string {
    if (value === null) return "never";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  // Only this save's own answer closes it out: an unrelated state frame leaves
  // the wait (and the typed key) alone, and a refusal keeps the draft for a retry.
  $effect(() => {
    const requestId = saving;
    const result = providers.saveResult;
    if (requestId === null || result === null || result.requestId !== requestId) return;
    saving = null;
    if (result.ok) resetForm();
  });
</script>

<Dialog.Root
  open={providers.open}
  onOpenChange={(value) => {
    if (!value) {
      resetForm();
      providers.closeDialog();
    }
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay" />
    <Dialog.Content class="dialog-content providers-dialog" data-testid="providers-dialog">
      <div class="dialog-header">
        <Dialog.Title class="dialog-title">Providers</Dialog.Title>
        <CommandButton
          variant="outline"
          size="sm"
          label="Refresh"
          evidence={() => providers.subscriptions}
          command={() => providers.refresh()}
          data-testid="provider-refresh"
          data-command="settings.providers.refresh"
        >
          Refresh
        </CommandButton>
      </div>
      <div class="dialog-body providers-body">
        <Dialog.Description class="providers-rule" data-testid="provider-rule">
          Two providers: OpenCode Go first, then the OpenRouter fallback. A key is used only when
          every quota window is above 1% remaining; the harness {providers.rule}. Usage is checked
          at most once a minute unless refreshed.
        </Dialog.Description>

        {#if providers.error !== null}
          <p class="providers-error" data-testid="provider-error" role="alert">{providers.error}</p>
        {/if}

        <form
          class="providers-form"
          onsubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label class="providers-field">
            <span>Provider</span>
            <select
              data-testid="provider-select"
              bind:value={provider}
              disabled={editing !== null}
            >
              <option value="opencode-go">OpenCode Go</option>
              <option value="openrouter">OpenRouter</option>
            </select>
            <span class="providers-model" data-testid="provider-model">
              model <span class="mono">{PROVIDERS[provider].model}</span>
            </span>
          </label>
          <label class="providers-field">
            <span>Label</span>
            <Input
              data-testid="provider-label-input"
              placeholder={providersProviderName(provider)}
              value={label}
              oninput={(event) => (label = (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label class="providers-field providers-field--key">
            <span>API key</span>
            <Input
              data-testid="provider-key-input"
              type="password"
              autocomplete="off"
              placeholder={editing === null ? "Paste the key" : "Leave blank to keep the current key"}
              value={key}
              oninput={(event) => (key = (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <div class="providers-form-actions">
            {#if editing !== null}
              <Button variant="ghost" size="sm" data-testid="provider-cancel-edit" onclick={resetForm}>
                Cancel
              </Button>
            {/if}
            <Button
              variant="default"
              size="sm"
              type="submit"
              busy={savePending.busy}
              busyLabel={editing === null ? "Adding…" : "Saving…"}
              data-testid="provider-save"
              data-command="settings.providers.save"
              disabled={editing === null && key.trim().length === 0}
            >
              {editing === null ? "Add key" : "Save changes"}
            </Button>
            <SaveFeedback scope="providers.form" />
          </div>
        </form>
        {#if savePending.notice !== null}
          <CommandNotice text={savePending.notice} ondismiss={() => savePending.dismiss()} />
        {/if}

        <div class="providers-list" data-testid="provider-list">
          {#if providers.subscriptions.length === 0}
            <p class="providers-empty" data-testid="provider-empty">
              No provider subscription is configured. Peers cannot start until one is added.
            </p>
          {/if}
          {#each providers.subscriptions as subscription (subscription.id)}
            <div
              class="provider-row"
              data-testid="provider-row"
              data-provider={subscription.provider}
              data-status={subscription.status}
            >
              <div class="provider-row__head">
                <div class="provider-row__identity">
                  <span class="provider-row__name" data-testid="provider-row-provider">
                    {subscription.providerName}
                  </span>
                  <span class="mono" data-testid="provider-mask">{subscription.maskedKey}</span>
                  <span class="provider-row__label">{subscription.label}</span>
                </div>
                <span class="provider-row__status" data-testid="provider-status">
                  {statusText(subscription.status)}
                </span>
              </div>
              <div class="provider-row__meta">
                {#each subscription.windows as window (window.key)}
                  <span class="provider-window" data-testid="provider-window">
                    {window.label}: {percentText(window.remainingFraction)} remaining
                    {#if window.percentUsed !== null}
                      ({Math.round(window.percentUsed * 10) / 10}% used)
                    {/if}
                  </span>
                {/each}
                <span class="mono provider-row__model" data-testid="provider-row-model">
                  {PROVIDERS[subscription.provider].model}
                </span>
                <span class="provider-row__checked" data-testid="provider-last-checked">
                  checked {checkedAt(subscription.lastCheckedAt)}
                </span>
              </div>
              {#if subscription.error !== null}
                <p class="provider-row__error" data-testid="provider-row-error">{subscription.error}</p>
              {/if}
              <div class="provider-row__actions">
                <label class="provider-enabled">
                  <input
                    type="checkbox"
                    data-testid="provider-enabled"
                    checked={subscription.enabled}
                    onchange={(event) =>
                      providers.setEnabled(
                        subscription.id,
                        (event.currentTarget as HTMLInputElement).checked,
                      )}
                  />
                  enabled
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="provider-edit"
                  onclick={() => startEdit(subscription)}
                >
                  Edit
                </Button>
                {#if pendingDelete === subscription.id}
                  <CommandButton
                    variant="destructive"
                    size="sm"
                    label="Confirm delete"
                    evidence={() => changeSeq}
                    command={confirmDelete}
                    data-testid="provider-delete-confirm"
                  >
                    Confirm delete
                  </CommandButton>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="provider-delete-cancel"
                    onclick={() => (pendingDelete = null)}
                  >
                    Cancel
                  </Button>
                {:else}
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="provider-delete"
                    onclick={() => (pendingDelete = subscription.id)}
                  >
                    Delete
                  </Button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .providers-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: calc(80vh - 56px);
  }

  :global(.providers-rule) {
    color: var(--muted-foreground);
    font-size: 11px;
    margin: 0;
  }

  .providers-error {
    background: var(--error-surface);
    border: 1px solid var(--error);
    border-radius: 4px;
    font-size: 12px;
    margin: 0;
    padding: 6px 8px;
  }

  .providers-form {
    align-items: end;
    display: grid;
    gap: 8px;
    grid-template-columns: 150px 1fr;
  }

  .providers-field {
    display: flex;
    flex-direction: column;
    font-size: 11px;
    gap: 4px;
  }

  .providers-field--key {
    grid-column: 1 / -1;
  }

  .providers-form-actions {
    display: flex;
    gap: 6px;
    grid-column: 1 / -1;
    justify-content: flex-end;
  }

  .providers-form select {
    background: var(--background);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--foreground);
    font-size: 12px;
    height: 28px;
    padding: 0 6px;
  }

  .providers-model {
    color: var(--muted-foreground);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .providers-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .providers-empty {
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
  }

  .provider-row {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  }

  .provider-row__head {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .provider-row__identity {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    font-size: 12px;
    gap: 8px;
  }

  .provider-row__name {
    font-weight: 600;
  }

  .provider-row__label {
    color: var(--muted-foreground);
  }

  .provider-row__status {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .provider-row[data-status="ok"] .provider-row__status {
    color: var(--success);
  }

  .provider-row[data-status="near-limit"] .provider-row__status {
    color: var(--warning);
  }

  .provider-row[data-status="exhausted"] .provider-row__status,
  .provider-row[data-status="invalid"] .provider-row__status {
    color: var(--error);
  }

  .provider-row__meta {
    color: var(--muted-foreground);
    display: flex;
    flex-wrap: wrap;
    font-size: 11px;
    gap: 4px 12px;
  }

  .provider-row__error {
    color: var(--error);
    font-size: 11px;
    margin: 0;
  }

  .provider-row__actions {
    align-items: center;
    display: flex;
    gap: 6px;
  }

  .provider-enabled {
    align-items: center;
    display: inline-flex;
    font-size: 11px;
    gap: 4px;
    margin-right: auto;
  }
</style>
