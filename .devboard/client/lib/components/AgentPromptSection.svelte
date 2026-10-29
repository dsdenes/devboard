<script lang="ts">
  import { agents } from "../agents.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    agentId: string;
  }

  let { agentId }: Props = $props();

  const prompt = $derived(agents.prompts[agentId] ?? null);
  const chat = $derived(agents.promptChat[agentId] ?? []);
  const notice = $derived(agents.promptNotice[agentId] ?? null);
  const error = $derived(
    agents.promptError[agentId] ?? (prompt?.error ?? null),
  );
  const chatError = $derived(agents.promptChatError[agentId] ?? null);
  const requestJson = $derived(
    prompt?.request === null || prompt?.request === undefined
      ? ""
      : JSON.stringify(prompt.request, null, 2),
  );

  let editor = $state("");
  let lastSaved = $state<string | null>(null);
  let message = $state("");

  // The editor adopts the file bytes on first render and whenever a new file
  // is saved elsewhere, but never replaces text the operator is editing.
  $effect(() => {
    const text = prompt?.text ?? null;
    if (text === null) return;
    if (lastSaved === text) return;
    if (lastSaved === null || editor === lastSaved) editor = text;
    lastSaved = text;
  });

  // A chat turn that proposes a replacement updates the editor without any
  // copy-paste; the file still changes only on Save.
  $effect(() => {
    const proposal = agents.promptProposal[agentId];
    if (proposal === null || proposal === undefined) return;
    editor = proposal.text;
  });

  function reset(): void {
    agents.resetPrompt(agentId);
    editor = prompt?.text ?? "";
    agents.promptError[agentId] = null;
    agents.promptNotice[agentId] = null;
  }

  function send(): void {
    const text = message.trim();
    if (text.length === 0) return;
    agents.sendPromptChat(agentId, text, editor);
    message = "";
  }
</script>

<section
  class="agent-prompt"
  data-testid="agent-prompt"
  data-agent={agentId}
  aria-label="Agent prompt"
>
  {#if prompt === null}
    <p class="agent-prompt__hint">Loading the prompt…</p>
  {:else if prompt.absent}
    <p class="agent-prompt__absent" data-testid="agent-prompt-absent">
      Watchdog runs no agent, so it has no prompt to show or edit.
    </p>
  {:else}
    <div class="agent-prompt__head">
      <h2 class="agent-prompt__title">Prompt</h2>
    </div>
    <p class="agent-prompt__command mono" data-testid="agent-prompt-command">
      {prompt.command}
    </p>
    {#if error !== null}
      <p class="issues-error" data-testid="agent-prompt-error" role="alert">{error}</p>
    {/if}
    {#if notice !== null}
      <p class="agent-prompt__notice" data-testid="agent-prompt-notice" role="status">
        {notice}
      </p>
    {/if}
    <pre class="agent-prompt__text mono" data-testid="agent-prompt-text">{prompt.text ?? ""}</pre>

    <div class="agent-prompt__request">
      <h3 class="agent-prompt__subtitle">Next request</h3>
      <pre class="agent-prompt__text mono" data-testid="agent-prompt-request">{requestJson}</pre>
      <p class="agent-prompt__hint">
        <span class="mono">scanId</span> and <span class="mono">createdAt</span> are assigned when
        the scan starts; every other value is what the next scan reads.
      </p>
    </div>

    {#if prompt.editable}
      <div class="agent-prompt__editor">
        <label class="agent-prompt__subtitle" for={`agent-prompt-editor-${agentId}`}>
          Editor
        </label>
        <textarea
          id={`agent-prompt-editor-${agentId}`}
          class="agent-prompt__textarea mono"
          data-testid="agent-prompt-editor"
          spellcheck="false"
          value={editor}
          oninput={(event) => (editor = event.currentTarget.value)}
        ></textarea>
        <div class="agent-prompt__actions">
          <Button variant="secondary" data-testid="agent-prompt-save" onclick={() => agents.savePrompt(agentId, editor)}>
            Save prompt
          </Button>
          <Button variant="secondary" data-testid="agent-prompt-reset" onclick={reset}>
            Reset
          </Button>
        </div>
      </div>

      <section class="agent-prompt__chat" data-testid="agent-prompt-chat" aria-label="Prompt chat">
        <h3 class="agent-prompt__subtitle">Revise with an agent</h3>
        <div class="agent-prompt__chat-log" data-testid="agent-prompt-chat-log" role="log">
          {#each chat as entry}
            <div class="agent-prompt__chat-entry" data-role={entry.role}>
              <span class="agent-prompt__chat-role">{entry.role}</span>
              <span class="agent-prompt__chat-text">{entry.text}</span>
            </div>
          {/each}
        </div>
        {#if chatError !== null}
          <p class="issues-error" data-testid="agent-prompt-chat-error" role="alert">
            {chatError}
          </p>
        {/if}
        <div class="agent-prompt__chat-input">
          <Input
            data-testid="agent-prompt-message"
            placeholder="Describe the change you want"
            value={message}
            oninput={(event) => (message = event.currentTarget.value)}
            onkeydown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <Button variant="secondary" data-testid="agent-prompt-send" onclick={send}>
            Send
          </Button>
        </div>
        <p class="agent-prompt__hint">
          The chat proposes text in the editor; only Save writes the prompt file.
        </p>
      </section>
    {/if}
  {/if}
</section>

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

  .agent-prompt__head {
    align-items: baseline;
    display: flex;
    gap: 10px;
  }

  .agent-prompt__title {
    font-size: 12px;
    font-weight: 700;
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

  .agent-prompt__command {
    font-size: 11px;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .agent-prompt__subtitle {
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  .agent-prompt__text {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.45;
    margin: 0;
    max-height: 220px;
    overflow: auto;
    padding: 8px;
    white-space: pre;
  }

  .agent-prompt__request,
  .agent-prompt__editor,
  .agent-prompt__chat {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .agent-prompt__textarea {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 11px;
    line-height: 1.45;
    min-height: 180px;
    padding: 8px;
    resize: vertical;
    white-space: pre;
    width: 100%;
  }

  .agent-prompt__actions,
  .agent-prompt__chat-input {
    align-items: center;
    display: flex;
    gap: 8px;
  }

  .agent-prompt__chat-log {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 3px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 180px;
    min-height: 24px;
    overflow: auto;
    padding: 8px;
  }

  .agent-prompt__chat-entry {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .agent-prompt__chat-role {
    color: var(--muted-foreground);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .agent-prompt__chat-text {
    font-size: 11px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .agent-prompt__notice {
    color: var(--success, var(--accent));
    font-size: 11px;
    margin: 0;
  }
</style>
