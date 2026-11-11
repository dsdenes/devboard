<script lang="ts">
  import { issues } from "../issues.svelte";
  import type { RunQuestion } from "../types";
  import { createCommandBusy } from "../command-busy.svelte";
  import Button from "./ui/button.svelte";
  import CommandButton from "./CommandButton.svelte";
  import CommandNotice from "./CommandNotice.svelte";
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

  // The draft belongs to the question it answers. The Overview pane and the
  // Focus tab reuse one instance as the selected agent changes, so a switch to
  // another run or question clears the text instead of carrying the previous
  // agent's draft to the new subject.
  const subject = $derived(`${runId ?? ""}\u0000${question.id}`);
  let shownSubject = $state<string | undefined>(undefined);

  $effect(() => {
    const next = subject;
    if (next === shownSubject) return;
    shownSubject = next;
    answer = "";
  });

  /** One answer at a time; the question this control answers is the evidence. */
  const answerPending = createCommandBusy({ label: "Answer", evidence: () => question });

  function submit(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    answerPending.start();
    if (onanswer !== undefined) onanswer(trimmed);
    else if (runId !== undefined) issues.submitAgentAnswer(runId, question.id, trimmed);
    answer = "";
  }
</script>

<div class="issues-question" data-testid={testid} data-run={runId}>
  <h3 class="issues-question__message">{question.message}</h3>
  {#if question.options.length > 0}
    <div class="choice-list">
      {#each question.options as option (option.label)}
        <CommandButton
          bare
          class="choice"
          label={option.label}
          busyLabel="Answering…"
          evidence={() => question}
          command={() => submit(option.label)}
          data-testid={choiceTestid}
          data-run={runId}
          data-command={command}
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
        </CommandButton>
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
      label="Answer"
      busy={answerPending.busy}
      data-command={command}
      data-testid={submitTestid}
      data-run={runId}
      disabled={answer.trim().length === 0}
    >
      Answer
    </Button>
  </form>
  {#if answerPending.notice !== null}
    <CommandNotice text={answerPending.notice} ondismiss={() => answerPending.dismiss()} />
  {/if}
</div>
