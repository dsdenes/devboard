<script lang="ts">
  import { issues } from "../issues.svelte";
  import type { RunQuestion } from "../types";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    question: RunQuestion;
    testid: string;
    /** The agent run answering through the shared store; omitted by the draft surface. */
    runId?: string;
    /** Submits the answer; defaults to the agent-run store call for `runId`. */
    onanswer?: (value: string) => void;
    choiceTestid?: string;
    inputTestid?: string;
    submitTestid?: string;
    command?: string;
  }

  let {
    question,
    testid,
    runId,
    onanswer,
    choiceTestid = "issues-agent-choice",
    inputTestid = "issues-agent-answer-input",
    submitTestid = "issues-agent-answer-submit",
    command = "issues.answer",
  }: Props = $props();

  let answer = $state("");

  function submit(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (onanswer !== undefined) onanswer(trimmed);
    else if (runId !== undefined) issues.submitAgentAnswer(runId, question.id, trimmed);
    answer = "";
  }
</script>

<div class="issues-question" data-testid={testid} data-run={runId}>
  <p>{question.message}</p>
  {#if question.options.length > 0}
    <div class="choice-list">
      {#each question.options as option (option.label)}
        <button
          type="button"
          class="choice"
          data-testid={choiceTestid}
          data-run={runId}
          data-command={command}
          onclick={() => submit(option.label)}
        >
          <span class="choice__label">
            {option.label}
            {#if option.recommended}
              <span class="choice__recommended">Recommended</span>
            {/if}
          </span>
          {#if option.description}
            <span class="choice__description">{option.description}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
  <form
    class="issues-answer"
    onsubmit={(event) => {
      event.preventDefault();
      submit(answer);
    }}
  >
    <Input
      type="text"
      value={answer}
      oninput={(event) => (answer = event.currentTarget.value)}
      placeholder="Your answer"
      aria-label="Your answer"
      data-testid={inputTestid}
      data-run={runId}
    />
    <Button
      variant="default"
      type="submit"
      data-command={command}
      data-testid={submitTestid}
      data-run={runId}
      disabled={answer.trim().length === 0}
    >
      Answer
    </Button>
  </form>
</div>
