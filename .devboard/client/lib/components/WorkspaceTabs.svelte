<script lang="ts">
  import X from "lucide-svelte/icons/x";
  import { layout } from "../layout.svelte";
  import type { WorkspaceTab } from "../layout.svelte";

  interface Props {
    dirty: (tab: WorkspaceTab) => boolean;
    onactivate: (tab: WorkspaceTab) => void;
    onclose: (tab: WorkspaceTab) => void;
  }

  let { dirty, onactivate, onclose }: Props = $props();

  let strip: HTMLDivElement | undefined = $state();

  function onkeydown(event: KeyboardEvent, index: number): void {
    const tabs = layout.tabs[layout.mode];
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next !== undefined) {
      onactivate(next);
      queueMicrotask(() => {
        const buttons = strip?.querySelectorAll<HTMLButtonElement>(".workspace-tab__button");
        buttons?.[tabs.indexOf(next)]?.focus();
      });
    }
  }
</script>

<div
  class="workspace-tabs"
  data-testid="workspace-tabs"
  role="tablist"
  aria-label="Workspace tabs"
  bind:this={strip}
>
  {#each layout.tabs[layout.mode] as tab, index (tab.id)}
    {@const selected = layout.activeTab[layout.mode] === tab.id}
    {@const isDirty = dirty(tab)}
    <div class="workspace-tab-frame" class:selected>
      <button
        type="button"
        role="tab"
        class="workspace-tab__button"
        aria-selected={selected}
        aria-controls={`workspace-${layout.mode}`}
        id={`workspace-tab-${tab.id}`}
        tabindex={selected ? 0 : -1}
        data-command={`tab.activate.${layout.mode}.${tab.id}`}
        data-testid="workspace-tab"
        title={tab.title}
        onclick={() => onactivate(tab)}
        onkeydown={(event) => onkeydown(event, index)}
      >
        <span class="workspace-tab__label">{tab.title}</span>
        {#if isDirty}
          <span
            class="workspace-tab__dirty"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          ></span>
        {/if}
      </button>
      <button
        type="button"
        class="workspace-tab__close"
        aria-label={`Close ${tab.title}`}
        title={`Close ${tab.title}`}
        data-command={`tab.close.${layout.mode}.${tab.id}`}
        data-testid="workspace-tab-close"
        onclick={(event) => {
          event.stopPropagation();
          onclose(tab);
        }}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  {/each}
</div>

<style>
  .workspace-tabs {
    align-items: stretch;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    flex: 0 0 34px;
    gap: 1px;
    height: 34px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }

  .workspace-tab-frame {
    align-items: center;
    border: 1px solid transparent;
    border-bottom: 0;
    display: flex;
    flex: 0 0 auto;
    max-width: 260px;
  }

  .workspace-tab-frame.selected {
    background: var(--background);
    border-color: var(--border);
  }

  .workspace-tab__button {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--muted-foreground);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: 12px;
    gap: 6px;
    height: 32px;
    max-width: 220px;
    padding: 0 4px 0 8px;
  }

  .workspace-tab__button:hover {
    color: var(--foreground);
  }

  .workspace-tab-frame.selected .workspace-tab__button {
    color: var(--foreground);
  }

  .workspace-tab__label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-tab__dirty {
    background: var(--warning);
    border-radius: 999px;
    flex: 0 0 auto;
    height: 6px;
    width: 6px;
  }

  .workspace-tab__close {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 3px;
    color: var(--muted-foreground);
    cursor: pointer;
    display: flex;
    height: 18px;
    justify-content: center;
    margin-right: 3px;
    padding: 0;
    width: 18px;
  }

  .workspace-tab__close:hover {
    background: var(--secondary-hover);
    color: var(--foreground);
  }

  .workspace-tab__button:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }
</style>
