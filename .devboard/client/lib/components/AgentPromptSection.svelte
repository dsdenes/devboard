<script lang="ts">
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import { agentRegistry } from "../../../server/agents/registry";
  import { agents } from "../agents.svelte";

  interface Props {
    agentId: string;
  }

  let { agentId }: Props = $props();

  const descriptor = $derived(agentRegistry.get(agentId));
  const prompt = $derived(agents.prompts[agentId] ?? null);
  const error = $derived(prompt?.error ?? null);
  const promptFile = $derived(
    descriptor !== undefined && descriptor.prompt.kind === "file"
      ? `.devboard/prompts/${descriptor.prompt.file}`
      : null,
  );
</script>

<details
  class="agent-prompt"
  data-testid="agent-prompt"
  data-agent={agentId}
  aria-label="Agent prompt"
>
  <summary class="agent-prompt__summary" data-testid="agent-prompt-summary">
    <span class="agent-prompt__title">Prompt</span>
    <span class="agent-prompt__meta">
      {#if promptFile !== null}
        <span class="agent-prompt__file mono" title={promptFile}>{promptFile}</span>
      {/if}
      <span class="agent-prompt__chevron">
        <ChevronRight size={14} aria-hidden="true" />
      </span>
    </span>
  </summary>
  <div class="agent-prompt__body" data-testid="agent-prompt-body">
    {#if prompt === null}
      <p class="agent-prompt__hint">Loading the prompt…</p>
    {:else if prompt.template !== undefined && prompt.template !== null}
      <div class="agent-prompt__template" data-testid="agent-prompt-template">
        <pre class="agent-prompt__template-text mono" data-testid="agent-prompt-template-text">{prompt.template}</pre>
      </div>
    {:else if prompt.absent}
      <p class="agent-prompt__absent" data-testid="agent-prompt-absent">
        {descriptor?.prompt.kind === "absent"
          ? descriptor.prompt.message
          : `No prompt file is available for ${agentId}.`}
      </p>
    {:else}
      {#if error !== null}
        <p class="issues-error" data-testid="agent-prompt-error" role="alert">{error}</p>
      {/if}
      <pre class="agent-prompt__text mono" data-testid="agent-prompt-text" aria-label={`${descriptor?.label ?? agentId} prompt`}>{prompt.text ?? ""}</pre>
    {/if}
  </div>
</details>

<style>
  .agent-prompt {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }

  .agent-prompt__summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: 8px;
    height: 30px;
    list-style: none;
    padding: 0 8px;
  }

  .agent-prompt__summary::-webkit-details-marker {
    display: none;
  }

  .agent-prompt__summary:hover {
    background: var(--row-hover);
  }

  .agent-prompt__summary:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  .agent-prompt[open] .agent-prompt__summary {
    border-bottom: 1px solid var(--border);
  }

  .agent-prompt__title {
    flex: 0 0 auto;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
  }

  .agent-prompt__meta {
    align-items: center;
    display: flex;
    gap: 8px;
    margin-left: auto;
    min-width: 0;
  }

  .agent-prompt__file {
    background: var(--background);
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    color: var(--muted-foreground);
    flex: 0 1 auto;
    font-size: 11.5px;
    line-height: 1.4;
    min-width: 0;
    overflow: hidden;
    padding: 2px 6px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-prompt__chevron {
    align-items: center;
    color: var(--muted-foreground);
    display: inline-flex;
    flex: 0 0 auto;
    transition: transform 120ms ease;
  }

  .agent-prompt[open] .agent-prompt__chevron {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .agent-prompt__chevron {
      transition: none;
    }
  }

  .agent-prompt__body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
  }

  .agent-prompt__hint,
  .agent-prompt__absent {
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
  }

  .agent-prompt__template {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .agent-prompt__text,
  .agent-prompt__template-text {
    background: var(--background);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
    max-height: clamp(240px, 46vh, 480px);
    overflow: auto;
    padding: 8px;
    white-space: pre;
  }
</style>
