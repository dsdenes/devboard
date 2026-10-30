<script lang="ts">
  import { discoverAgent } from "../../../server/agents/registry";
  import { discover } from "../discover.svelte";
  import { relativeTime } from "../discover-format";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    agent: string;
  }

  let { agent }: Props = $props();

  const descriptor = $derived(discoverAgent(agent));
  const descriptorLabel = $derived(descriptor?.label ?? agent);
  const descriptorCommand = $derived(descriptor?.command ?? "");
  const card = $derived(discover.agent(agent));
  const prompt = $derived(discover.agentPrompt(agent));
  const editable = $derived(prompt?.editable === true);
  const running = $derived(discover.active && discover.activeAgent === agent);
  const activity = $derived(discover.agentActivityOf(agent));
  const question = $derived(discover.agentQuestionOf(agent));
  const chat = $derived(discover.promptChat[agent] ?? []);
  const proposal = $derived(discover.promptProposal[agent] ?? null);
  const promptError = $derived(discover.promptError[agent] ?? (prompt?.error ?? null));
  const promptNotice = $derived(discover.promptNotice[agent] ?? null);
  const chatError = $derived(discover.promptChatError[agent] ?? null);
  const status = $derived(card?.state ?? "idle");
  const startedAt = $derived(card?.startedAt ?? null);
  const endedAt = $derived(card?.endedAt ?? null);

  let editor = $state("");
  let lastText = $state<string | null>(null);
  let message = $state("");
  let now = $state(Date.now());

  // The editor adopts the file's bytes on first render and whenever the file
  // changes elsewhere, but never replaces text the operator is editing.
  $effect(() => {
    const text = prompt?.text ?? null;
    if (text === null) return;
    if (lastText === text) return;
    if (lastText === null || editor === lastText) editor = text;
    lastText = text;
  });

  // A chat turn that proposes a replacement updates the editor directly; the
  // file still changes only on Save.
  $effect(() => {
    const value = proposal;
    if (value === null) return;
    editor = value.text;
    discover.consumeProposal(agent);
  });

  // Reset restores the editor to the file's current bytes and writes nothing.
  $effect(() => {
    const token = discover.resetToken(agent);
    if (token === 0) return;
    const text = prompt?.text ?? "";
    editor = text;
    lastText = text;
  });

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(timer);
  });

  function send(): void {
    const text = message.trim();
    if (text.length === 0 || !editable) return;
    discover.sendPromptChat(agent, text, editor);
    message = "";
  }
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
        <p class="discover-page__subtitle">
          One ACP peer, one staged slice, and only this agent's artifacts are published.
        </p>
        <code
          class="code-chip"
          data-testid="discover-agent-prompt-command"
        >{descriptorCommand} &lt;staging-dir&gt;</code>
      </div>
      <div class="discover-agent__actions">
        <span
          class="discover-agent__state"
          data-state={status}
          data-testid="discover-agent-status"
          title={endedAt ?? startedAt ?? ""}
        >
          {#if status === "running" && startedAt !== null}
            running · started {relativeTime(startedAt, now)}
          {:else if status === "succeeded" && endedAt !== null}
            succeeded · {relativeTime(endedAt, now)}
          {:else if status === "failed"}
            failed
          {:else}
            idle
          {/if}
        </span>
        {#if running}
          <div
            class="discover-run-tag"
            data-testid="discover-agent-run-tag"
            role="status"
            aria-live="polite"
          >
            <span class="discover-run__dot" aria-hidden="true"></span>
            <strong>{descriptorLabel} run in progress</strong>
            <button
              type="button"
              class="discover-run__stop"
              data-testid="discover-agent-stop"
              data-command={`discover.agent.stop.${agent}`}
              title="Stop this discovery agent"
              onclick={() => discover.stop()}
            >
              Stop
            </button>
          </div>
        {:else}
          <Button
            variant="default"
            data-command={`discover.agent.start.${agent}`}
            data-testid="discover-agent-start"
            disabled={discover.agentStartDisabled(agent)}
            title={discover.agentStartTitle(agent)}
            onclick={() => discover.startAgent(agent)}
          >
            {status === "idle" ? "Start" : "Re-run"}
          </Button>
        {/if}
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
                <button
                  type="button"
                  class="choice"
                  data-testid="discover-agent-choice"
                  onclick={() => discover.answer(option.label)}
                >
                  <span class="choice__label">
                    {option.label}
                    {#if option.recommended}
                      <span class="choice__recommended">Recommended</span>
                    {/if}
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <section class="panel discover-agent__activity" aria-label="Agent activity">
      <div class="panel__header">
        <h2 class="panel__title">Activity</h2>
        <span class="panel__subtitle">{activity.length} lines</span>
      </div>
      <div
        class="panel__body discover-agent__activity-log"
        data-testid="discover-agent-activity"
        role="log"
        aria-live="polite"
      >
        {#if activity.length === 0}
          <p class="empty">No activity yet. Start the agent to see its lines here.</p>
        {:else}
          {#each activity as line, index (index)}
            <div class="discover-agent__activity-line">{line}</div>
          {/each}
        {/if}
      </div>
    </section>

    <section class="panel discover-agent__prompt" aria-label="Agent prompt">
      <div class="panel__header">
        <h2 class="panel__title">Prompt</h2>
        <span class="panel__subtitle">
          {editable ? "Editable in this source checkout" : "Read-only here"}
        </span>
      </div>
      <div class="panel__body stack-sm">
        {#if promptError !== null}
          <p class="message" data-severity="error" data-testid="discover-agent-prompt-error" role="alert">
            {promptError}
          </p>
        {/if}
        {#if promptNotice !== null}
          <p class="discover-agent__notice" data-testid="discover-agent-prompt-notice" role="status">
            {promptNotice}
          </p>
        {/if}
        {#if editable}
          <div class="discover-agent__prompt-editor">
            <textarea
              class="discover-agent__textarea mono"
              data-testid="discover-agent-prompt-editor"
              aria-label={`${descriptorLabel} prompt editor`}
              spellcheck="false"
              value={editor}
              oninput={(event) => (editor = event.currentTarget.value)}
            ></textarea>
            <div class="discover-agent__prompt-actions">
              <Button
                variant="secondary"
                data-testid="discover-agent-prompt-save"
                data-command={`discover.prompt.save.${agent}`}
                onclick={() => discover.savePrompt(agent, editor)}
              >
                Save prompt
              </Button>
              <Button
                variant="outline"
                data-testid="discover-agent-prompt-reset"
                title="Restore the editor to this prompt file's bytes without writing."
                onclick={() => discover.resetPrompt(agent)}
              >
                Reset
              </Button>
            </div>
          </div>

          <section class="discover-agent__chat" aria-label="Prompt chat">
            {#if chat.length > 0}
              <div
                class="discover-agent__chat-log"
                data-testid="discover-agent-prompt-chat-log"
                role="log"
              >
                {#each chat as entry, index (index)}
                  <div class="discover-agent__chat-entry" data-role={entry.role}>
                    <span class="discover-agent__chat-role">{entry.role}</span>
                    <span class="discover-agent__chat-text">{entry.text}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if chatError !== null}
              <p
                class="message"
                data-severity="error"
                data-testid="discover-agent-prompt-chat-error"
                role="alert"
              >
                {chatError}
              </p>
            {/if}
            <div class="discover-agent__chat-input">
              <Input
                data-testid="discover-agent-prompt-message"
                placeholder="Describe the prompt change you want"
                value={message}
                oninput={(event) => (message = event.currentTarget.value)}
                onkeydown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <Button
                variant="secondary"
                data-testid="discover-agent-prompt-send"
                onclick={send}
              >
                Send
              </Button>
            </div>
          </section>
        {/if}
      </div>
    </section>
  </div>
{/if}
