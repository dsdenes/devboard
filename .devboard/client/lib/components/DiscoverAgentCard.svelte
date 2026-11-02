<script lang="ts">
  import { discoverAgent } from "../../../server/agents/registry";
  import { discover } from "../discover.svelte";
  import { relativeTime } from "../discover-format";
  import CommandButton from "./CommandButton.svelte";

  interface Props {
    agent: string;
  }

  let { agent }: Props = $props();

  const descriptor = $derived(discoverAgent(agent));
  const descriptorLabel = $derived(descriptor?.label ?? agent);
  const card = $derived(discover.agent(agent));
  const prompt = $derived(discover.agentPrompt(agent));
  const running = $derived(discover.active && discover.activeAgent === agent);
  const question = $derived(discover.agentQuestionOf(agent));
  const promptError = $derived(prompt?.error ?? null);
  const status = $derived(card?.state ?? "idle");
  const startedAt = $derived(card?.startedAt ?? null);
  const endedAt = $derived(card?.endedAt ?? null);
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(timer);
  });
</script>

{#if descriptor !== null}
  <div
    class="scroll-column discover-page discover-agent"
    data-testid="discover-agent"
    data-agent={agent}
    data-state={status}
    aria-label={descriptorLabel}
  >
    <header class="discover-page__header discover-agent__header">
      <div class="discover-page__heading">
        <h1 class="discover-page__title">{descriptorLabel}</h1>
      </div>
    </header>

    {#if card?.error !== null && card?.error !== undefined}
      <p class="message" data-severity="error" data-testid="discover-agent-error" role="alert">
        {card.error}
      </p>
    {/if}

    {#if question !== null && running}
      <section class="panel discover-question" data-testid="discover-agent-question">
        <div class="panel__header">
          <h2 class="panel__title">The agent needs a decision</h2>
          <span class="panel__subtitle">Answered once</span>
        </div>
        <div class="panel__body stack-sm">
          <p class="discover-question__message">{question.message}</p>
          {#if question.options.length > 0}
            <div class="choice-list">
              {#each question.options as option (option.label)}
                <CommandButton
                  bare
                  class="choice"
                  label={option.label}
                  busyLabel="Answering…"
                  evidence={() => discover.agentQuestionOf(agent)}
                  command={() => discover.answer(option.label)}
                  data-testid="discover-agent-choice"
                >
                  <span class="choice__label">
                    {option.label}
                    {#if option.recommended}
                      <span class="choice__recommended">Recommended</span>
                    {/if}
                  </span>
                </CommandButton>
              {/each}
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <section
      class="panel discover-agent__prompt"
      data-testid="discover-agent-prompt"
      aria-label="Agent prompt"
    >
      <div class="panel__header">
        <h2 class="panel__title">Prompt</h2>
        <span class="panel__subtitle">Read-only here</span>
      </div>
      <div class="panel__body stack-sm">
        {#if promptError !== null}
          <p class="message" data-severity="error" data-testid="discover-agent-prompt-error" role="alert">
            {promptError}
          </p>
        {/if}
        {#if prompt === null}
          <p class="muted">Loading the prompt…</p>
        {:else}
          <pre class="discover-agent__prompt-text mono" data-testid="discover-agent-prompt-text" aria-label={`${descriptorLabel} prompt`}>{prompt.text ?? ""}</pre>
        {/if}
      </div>
    </section>
  </div>
{/if}

<style>
  .discover-agent__prompt-text {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 3px;
    flex: 1;
    font-size: 11px;
    line-height: 1.45;
    margin: 0;
    max-height: 420px;
    min-height: 0;
    overflow: auto;
    padding: 8px;
    white-space: pre;
  }
</style>
