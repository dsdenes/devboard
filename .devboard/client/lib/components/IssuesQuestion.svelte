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
    /**
     * Submits the answer; defaults to the agent-run store call for `runId`.
     * Returns false when it sent nothing, so the control keeps the draft.
     */
    onanswer?: (value: string) => boolean | void;
    /**
     * Reactive revision bumped by the frame that answers a dispatched answer.
     * It releases the latch on a server refusal instead of the ceiling.
     */
    answerRevision?: () => number;
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
    answerRevision = () => 0,
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

  /**
   * One answer at a time. The answering frame is the evidence: an accepted
   * answer changes the question, and a refused one bumps `answerRevision`
   * without changing it, so the refusal never reaches the ceiling notice.
   */
  const answerPending = createCommandBusy({
    label: "Answer",
    evidence: () => answerRevision(),
    scope: () => subject,
  });

  /**
   * Dispatches one answer. The draft stays in the input until the question
   * changes, which is the accepted answer; a dispatch that sent nothing leaves
   * it for the retry. Returns whether a frame was sent.
   */
  function submit(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    answerPending.start();
    const sent =
      onanswer !== undefined
        ? onanswer(trimmed) !== false
        : runId !== undefined
          ? issues.submitAgentAnswer(runId, question.id, trimmed)
          : false;
    if (!sent) answerPending.refuse();
    return sent;
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
          evidence={() => answerRevision()}
          scope={() => subject}
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
