<script lang="ts">
  import { agentRegistry } from "../../../server/agents/registry";
  import { agents } from "../agents.svelte";
  import SaveFeedback from "./SaveFeedback.svelte";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    agentId: string;
  }

  let { agentId }: Props = $props();

  const descriptor = $derived(agentRegistry.get(agentId));
  const prompt = $derived(agents.prompts[agentId] ?? null);
  const chat = $derived(agents.promptChat[agentId] ?? []);
  const error = $derived(
    agents.promptError[agentId] ?? (prompt?.error ?? null),
  );
  const chatError = $derived(agents.promptChatError[agentId] ?? null);

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
    agents.consumePromptProposal(agentId);
  });

  function send(): void {
    const text = message.trim();
    if (text.length === 0) return;
    agents.sendPromptChat(agentId, text, editor);
    message = "";
  }
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

      {#if prompt.editable}
        <div class="agent-prompt__editor">
          <textarea
            class="agent-prompt__textarea mono"
            data-testid="agent-prompt-editor"
            aria-label="Prompt editor"
            spellcheck="false"
            value={editor}
            oninput={(event) => (editor = event.currentTarget.value)}
          ></textarea>
          <div class="agent-prompt__actions">
            <Button variant="secondary" data-testid="agent-prompt-save" onclick={() => agents.savePrompt(agentId, editor)}>
              Save prompt
            </Button>
            <SaveFeedback scope={`agent.prompt.${agentId}`} />
          </div>
        </div>

        <section class="agent-prompt__chat" data-testid="agent-prompt-chat" aria-label="Prompt chat">
          {#if chat.length > 0}
            <div class="agent-prompt__chat-log" data-testid="agent-prompt-chat-log" role="log">
              {#each chat as entry}
                <div class="agent-prompt__chat-entry" data-role={entry.role}>
                  <span class="agent-prompt__chat-role">{entry.role}</span>
                  <span class="agent-prompt__chat-text">{entry.text}</span>
                </div>
              {/each}
            </div>
          {/if}
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
        </section>
      {/if}
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

  .agent-prompt__actions {
    flex-wrap: wrap;
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
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .agent-prompt__chat-text {
    font-size: 11px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

</style>
