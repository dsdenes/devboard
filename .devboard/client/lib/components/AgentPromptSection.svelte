<script lang="ts">
  import { agentRegistry } from "../../../server/agents/registry";
  import { agents } from "../agents.svelte";

  interface Props {
    agentId: string;
  }

  let { agentId }: Props = $props();

  const descriptor = $derived(agentRegistry.get(agentId));
  const prompt = $derived(agents.prompts[agentId] ?? null);
  const error = $derived(prompt?.error ?? null);
</script>

<details
  class="agent-prompt"
  data-testid="agent-prompt"
  data-agent={agentId}
  aria-label="Agent prompt"
>
  <summary class="agent-prompt__summary" data-testid="agent-prompt-summary">
    <span class="agent-prompt__title">Prompt</span>
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
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
  }

  .agent-prompt__summary {
    align-items: baseline;
    cursor: pointer;
    display: flex;
    gap: 10px;
    list-style-position: inside;
  }

  .agent-prompt__body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }

  .agent-prompt__title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    margin: 0;
    text-transform: uppercase;
  }

  .agent-prompt__hint {
    color: var(--muted-foreground);
    font-size: 11px;
    margin: 0;
  }

  .agent-prompt__absent {
    font-size: 12px;
    margin: 0;
  }

  .agent-prompt__text {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.45;
    margin: 0;
    max-height: 320px;
    overflow: auto;
    padding: 8px;
    white-space: pre;
  }

  .agent-prompt__template {
    display: flex;
    flex-direction: column;
  }

  .agent-prompt__template-text {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.45;
    margin: 0;
    max-height: 360px;
    overflow: auto;
    padding: 8px;
    white-space: pre;
  }
</style>
