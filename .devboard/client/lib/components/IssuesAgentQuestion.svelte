<script lang="ts">
  import { issues } from "../issues.svelte";
  import type { RunQuestion } from "../types";
  import Button from "./ui/button.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    runId: string;
    question: RunQuestion;
    testid: string;
  }

  let { runId, question, testid }: Props = $props();

  let answer = $state("");

  function submit(value: string): void {
    if (value.trim().length === 0) return;
    issues.submitAgentAnswer(runId, question.id, value.trim());
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
          data-testid="issues-agent-choice"
          data-run={runId}
          data-command="issues.answer"
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
      data-testid="issues-agent-answer-input"
      data-run={runId}
    />
    <Button
      variant="default"
      type="submit"
      data-command="issues.answer"
      data-testid="issues-agent-answer-submit"
      data-run={runId}
      disabled={answer.trim().length === 0}
    >
      Answer
    </Button>
  </form>
</div>
