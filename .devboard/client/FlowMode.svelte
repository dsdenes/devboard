<script lang="ts">
  import { html as diffHtml } from "diff2html";
  import "diff2html/bundles/css/diff2html.min.css";
  import { flow } from "./lib/flow.svelte";
  import { createCommandBusy } from "./lib/command-busy.svelte";
  import { layout } from "./lib/layout.svelte";
  import type { WorkspaceTab } from "./lib/layout.svelte";
  import { verificationTone } from "./lib/status-tone";
  import type { FlowFile, FlowWidget, RunQuestion } from "./lib/types";
  import AgentActivityBar from "./lib/components/AgentActivityBar.svelte";
  import CommandButton from "./lib/components/CommandButton.svelte";
  import CommandNotice from "./lib/components/CommandNotice.svelte";
  import DetailSplit from "./lib/components/DetailSplit.svelte";
  import Button from "./lib/components/ui/button.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab: (tab: WorkspaceTab) => void;
    closeTab: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab, closeTab }: Props = $props();

  const DIFF_OPTIONS = {
    outputFormat: "side-by-side" as const,
    drawFileList: false,
    matching: "lines" as const,
  };

  const activeWidget = $derived(tab?.kind === "widget" ? flow.widget(tab.resourceId) : null);
  const pendingSteering = $derived(flow.steering.filter((note) => note.status === "new").length);
  const focusedFile = $derived(tab?.kind === "file" ? flow.file(tab.resourceId) : null);
  const checkpoint = $derived(
    tab?.kind === "checkpoint" ? flow.checkpoint(tab.resourceId) : null,
  );
  const conversationWidget = $derived(
    flow.conversation === null ? null : flow.widget(flow.conversation.widgetId),
  );
  const overviewBarState = $derived(
    flow.goalCreation !== null
      ? ("running" as const)
      : flow.status === "running"
        ? ("running" as const)
        : flow.status === "stopped"
          ? ("stopped" as const)
          : ("idle" as const),
  );
  const overviewBarActivity = $derived(
    flow.goalCreation === null ? flow.activity : flow.goalCreation.activity,
  );
  const overviewBarQuestion = $derived(
    flow.goalCreation === null ? flow.question : flow.goalCreation.question,
  );
  const overviewBarStartedAt = $derived(
    overviewBarState !== "running"
      ? null
      : flow.goalCreation !== null
        ? flow.goalCreationStartedAt
        : flow.implementationStartedAt,
  );

  function openWidget(entry: FlowWidget): void {
    openTab({ id: `widget:${entry.id}`, kind: "widget", resourceId: entry.id, title: entry.concept });
  }

  function openFile(file: FlowFile): void {
    openTab({
      id: `file:${file.path}`,
      kind: "file",
      resourceId: file.path,
      title: file.path.split("/").pop() ?? file.path,
    });
  }

  function submitAnswer(pending: RunQuestion, target: "goal" | "implementation" | "conversation"): void {
    flow.answerQuestion(pending, flow.answers[target], target);
  }

  const answerPending = {
    goal: createCommandBusy({ label: "Submit answer", evidence: () => flow.activity.length }),
    implementation: createCommandBusy({
      label: "Submit answer",
      evidence: () => flow.activity.length,
    }),
    conversation: createCommandBusy({
      label: "Submit answer",
      evidence: () => flow.activity.length,
    }),
  };
  const conversationSendPending = createCommandBusy({
    label: "Send",
    evidence: () => flow.conversation?.messages.length,
  });

  const hasGoal = $derived(flow.goal.trim().length > 0);
  const goalHeaderState = $derived.by(() => {
    if (flow.goalCreation !== null) {
      return { state: "running", tone: "accent", label: "Interview running" };
    }
    if (hasGoal) {
      return { state: "saved", tone: "success", label: "Saved" };
    }
    return { state: "empty", tone: null, label: "No goal yet" };
  });
</script>

{#snippet questionPanel(
  pending: RunQuestion,
  target: "goal" | "implementation" | "conversation",
  testid: string,
)}
  <div class="flow-question" data-testid={testid} data-target={target}>
    <p class="muted" style="margin: 0 0 6px;">{pending.message}</p>
    {#if pending.options.length > 0}
      <div class="choice-list">
        {#each pending.options as option (option.label)}
          <CommandButton
            bare
            type="button"
            class="choice"
            label={option.label}
            busyLabel="Answering…"
            evidence={() => flow.activity.length}
            command={() => flow.answerQuestion(pending, option.label, target)}
            data-testid="flow-choice"
            data-command={`flow.answer.submit.${target}`}
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
      class="answer-form"
      style="margin-top: 6px;"
      onsubmit={(event) => {
        event.preventDefault();
        if (flow.answers[target].trim().length === 0) return;
        answerPending[target].start();
        submitAnswer(pending, target);
      }}
    >
      <input
        id={`flow-answer-${target}`}
        class="textarea"
        style="min-height: 28px; padding: 4px 6px;"
        type="text"
        value={flow.answers[target]}
        oninput={(event) => (flow.answers[target] = event.currentTarget.value)}
        placeholder="Your answer"
        aria-label="Your answer"
        data-testid="flow-answer-input"
      />
      <Button
        variant="default"
        type="submit"
        label="Submit answer"
        busy={answerPending[target].busy}
        data-command={`flow.answer.submit.${target}`}
        data-testid="flow-submit-answer"
        disabled={flow.answers[target].trim().length === 0}
      >
        Submit answer
      </Button>
    </form>
    {#if answerPending[target].notice !== null}
      <CommandNotice
        text={answerPending[target].notice}
        ondismiss={() => answerPending[target].dismiss()}
      />
    {/if}
  </div>
{/snippet}

{#snippet diffStack(files: FlowFile[])}
  <div
    class="diff-html"
    class:d2h-dark-color-scheme={layout.theme === "dark"}
    data-testid="flow-diff"
    style="height: 100%; overflow: auto;"
  >
    {#each files as file (file.path)}
      <div class="flow-diff-file">
        <p class="row-sm" style="margin: 4px 6px;">
          <code>{file.path}</code>
          <span class="badge" data-tone={file.status === "deleted" ? "error" : "accent"}>
            {file.status}
          </span>
          <span class="mono muted">+{file.insertions}/-{file.deletions}</span>
        </p>
        {#if file.omitted}
          <p class="muted" style="margin: 4px 6px;" data-testid="flow-diff-omitted">
            {file.omitted === "large"
              ? "Content omitted: the file is larger than the review limit."
              : file.omitted === "binary"
                ? "Content omitted: the file is binary."
                : "Content omitted: the link target could not be read."}
          </p>
        {:else}
          <div>{@html diffHtml(file.diff, DIFF_OPTIONS)}</div>
        {/if}
      </div>
    {:else}
      <p class="empty">No diff is available for this selection.</p>
    {/each}
  </div>
{/snippet}

{#snippet widgetDetail(entry: FlowWidget)}
  <section
    class="panel"
    data-testid="flow-widget-detail"
    data-widget-id={entry.id}
    data-category={entry.category}
  >
    <div class="panel__header">
      <h2 class="panel__title">{entry.concept}</h2>
      <div class="row-sm">
        <span class="badge" data-tone="accent">{entry.category}</span>
        <Button
          variant="outline"
          data-command={`tab.close.flow.${tab?.id ?? ""}`}
          data-testid="close-flow-widget-detail"
          onclick={() => {
            if (tab !== null) closeTab(tab);
          }}
        >
          Close
        </Button>
      </div>
    </div>
    <div class="panel__body stack-sm">
      <p style="margin: 0;">{entry.summary}</p>
      <p class="muted" style="margin: 0;">{entry.rationale}</p>
      <div>
        <div class="field__label">Files</div>
        <ul class="history-list">
          {#each flow.detailFiles(entry) as file (file.path)}
            <li>
              <Button
                bare
                type="button"
                class="sidebar-item"
                data-testid="flow-widget-file"
                data-command={`flow.file.open.${file.path}`}
                onclick={() => openFile(file)}
              >
                <code class="sidebar-item__label">{file.path}</code>
                <span class="badge" data-tone={file.status === "deleted" ? "error" : "accent"}>
                  {file.status}
                </span>
                <span class="mono muted">+{file.insertions}/-{file.deletions}</span>
              </Button>
            </li>
          {/each}
        </ul>
      </div>
      <div class="row-sm">
        <CommandButton
          variant="secondary"
          label={entry.accepted ? "Unaccept change" : "Accept change"}
          busyLabel={entry.accepted ? "Unaccepting…" : "Accepting…"}
          evidence={() => flow.widget(entry.id)?.accepted}
          command={() => flow.toggleWidget(entry)}
          data-command={`flow.widget.accept.${entry.id}`}
          data-testid="flow-widget-accept"
        >
          {entry.accepted ? "Unaccept change" : "Accept change"}
        </CommandButton>
        <CommandButton
          variant="secondary"
          label="Discuss"
          evidence={() => flow.conversation}
          command={() => flow.discuss(entry)}
          data-command={`flow.widget.discuss.${entry.id}`}
          data-testid="flow-widget-discuss"
        >
          Discuss
        </CommandButton>
        <Button
          variant="outline"
          data-command={`flow.widget.refuse.${entry.id}`}
          data-testid="flow-widget-refuse"
          onclick={() => flow.startRefuse(entry)}
        >
          Refuse
        </Button>
      </div>
      {#if flow.refusingId === entry.id}
        <div class="flow-refuse" data-testid="flow-refuse" style="margin-top: 6px;">
          <textarea
            class="textarea"
            data-testid="refuse-widget-reason"
            placeholder="Optional reason"
            aria-label="Reason for refusing this change"
            bind:value={flow.refuseReason}
          ></textarea>
          <div class="row-sm" style="justify-content: flex-end; margin-top: 4px;">
            <CommandButton
              variant="destructive"
              label="Confirm refuse"
              evidence={() => flow.widgets}
              command={() => flow.confirmRefuse(entry)}
              data-command={`flow.widget.refuse.confirm.${entry.id}`}
              data-testid="confirm-refuse-widget"
            >
              Confirm refuse
            </CommandButton>
            <Button
              variant="outline"
              data-command={`flow.widget.refuse.cancel.${entry.id}`}
              data-testid="cancel-refuse-widget"
              onclick={() => flow.cancelRefuse()}
            >
              Cancel
            </Button>
          </div>
        </div>
      {/if}
    </div>
  </section>
{/snippet}

{#snippet widgetsSection()}
  <section class="panel" data-testid="flow-widgets-section">
    <div class="panel__header">
      <h2 class="panel__title">Change widgets</h2>
      <span class="muted">{flow.widgets.length}</span>
    </div>
    <div class="panel__body panel__body--flush">
      {#each flow.widgets as widget (widget.id)}
        <div
          class="flow-widget"
          data-testid="flow-widget"
          data-widget-id={widget.id}
          data-accepted={widget.accepted ? "true" : "false"}
          data-category={widget.category}
          data-command={`flow.widget.open.${widget.id}`}
        >
          <span class="badge" data-tone="accent" data-category={widget.category}>
            {widget.category}
          </span>
          <Button
            bare
            type="button"
            class="sidebar-item grow"
            data-testid="flow-widget-open"
            data-command={`flow.widget.open.${widget.id}`}
            onclick={() => openWidget(widget)}
          >
            <span class="sidebar-item__label">{widget.concept}</span>
            <span class="muted" style="max-width: 40%; overflow: hidden; text-overflow: ellipsis;">
              {widget.summary}
            </span>
            <span class="mono muted">{widget.files.length} files</span>
          </Button>
          <label class="row-sm" style="gap: 4px;">
            <input
              type="checkbox"
              checked={widget.accepted}
              data-testid="flow-widget-accept"
              data-command={`flow.widget.accept.${widget.id}`}
              onchange={() => flow.toggleWidget(widget)}
            />
            <span class="muted">accepted</span>
          </label>
          <CommandButton
            variant="secondary"
            size="sm"
            label="Discuss"
            evidence={() => flow.conversation}
            command={() => flow.discuss(widget)}
            data-command={`flow.widget.discuss.${widget.id}`}
            data-testid="flow-widget-discuss"
          >
            Discuss
          </CommandButton>
          <Button
            variant="outline"
            size="sm"
            data-command={`flow.widget.refuse.${widget.id}`}
            data-testid="flow-widget-refuse"
            onclick={() => flow.startRefuse(widget)}
          >
            Refuse
          </Button>
        </div>
        {#if flow.refusingId === widget.id}
          <div class="flow-refuse" data-testid="flow-refuse" style="padding: 6px;">
            <textarea
              class="textarea"
              data-testid="refuse-widget-reason"
              placeholder="Optional reason"
              aria-label="Reason for refusing this change"
              bind:value={flow.refuseReason}
            ></textarea>
            <div class="row-sm" style="justify-content: flex-end; margin-top: 4px;">
              <CommandButton
                variant="destructive"
                label="Confirm refuse"
                evidence={() => flow.widgets}
                command={() => flow.confirmRefuse(widget)}
                data-command={`flow.widget.refuse.confirm.${widget.id}`}
                data-testid="confirm-refuse-widget"
              >
                Confirm refuse
              </CommandButton>
              <Button
                variant="outline"
                data-command={`flow.widget.refuse.cancel.${widget.id}`}
                data-testid="cancel-refuse-widget"
                onclick={() => flow.cancelRefuse()}
              >
                Cancel
              </Button>
            </div>
          </div>
        {/if}
      {:else}
        <p class="empty">No change widgets yet.</p>
      {/each}
    </div>
  </section>
{/snippet}

{#snippet goalPanel()}
  <section
    class="panel flow-goal-panel"
    class:flow-goal-panel--collapsed={flow.goalCreation !== null}
    class:flow-goal-panel--empty={flow.goalCreation === null && !hasGoal}
    data-testid="flow-goal"
    data-collapsed={flow.goalCreation === null ? "false" : "true"}
  >
    <div class="panel__header flow-goal__header">
      <div class="flow-goal__identity">
        <h2 class="panel__title flow-goal__title">Flow goal</h2>
        <span
          class="badge flow-goal__state"
          data-state={goalHeaderState.state}
          data-tone={goalHeaderState.tone}
          data-testid="flow-goal-state"
        >
          {goalHeaderState.label}
        </span>
      </div>
      <div class="row-sm flow-goal__actions">
        <Button
          variant={hasGoal ? "outline" : "default"}
          data-command="flow.goal.create"
          data-testid="create-flow-goal"
          onclick={() => flow.createGoal()}
        >
          {hasGoal ? "Recreate flow goal" : "Create flow goal"}
        </Button>
      </div>
    </div>
    {#if flow.goalCreation === null}
      {#if hasGoal}
        <div class="panel__body flow-goal-editor">
          <pre class="flow-document__text mono" data-testid="flow-goal-text" aria-label="Flow goal">{flow.goal}</pre>
        </div>
      {:else}
        <div class="panel__body flow-goal-onboarding" data-testid="flow-goal-onboarding">
          <p style="margin: 0;">
            The Flow goal starts as an <strong>interview</strong>: the agent asks one question at a
            time until the end result and its boundaries are settled. It writes one
            <strong>goal</strong>. The <strong>implementation</strong> agent then works from that
            goal in an isolated worktree.
          </p>
          <p class="muted" style="margin: 0;">
            Create flow goal starts the interview.
          </p>
        </div>
      {/if}
    {/if}
  </section>
{/snippet}

{#snippet overview()}
  <div class="scroll-column flow-overview">
    {@render goalPanel()}

    {#if flow.goalCreation !== null}
      {@const creation = flow.goalCreation}
      <section class="panel" data-testid="flow-goal-active">
        <div class="panel__header">
          <h2 class="panel__title">Goal interview</h2>
          <Button
            variant="outline"
            data-command="flow.goal.cancel"
            data-testid="cancel-flow-goal"
            onclick={() => flow.cancelGoal()}
          >
            Cancel goal interview
          </Button>
        </div>
        <div class="panel__body stack-sm">
          {#if creation.question !== null}
            {@render questionPanel(creation.question, "goal", "flow-goal-question")}
          {/if}
        </div>
      </section>
    {/if}

    {#if flow.question !== null}
      <section class="panel" data-testid="flow-question-section">
        <div class="panel__header">
          <h2 class="panel__title">Implementation question</h2>
        </div>
        <div class="panel__body">
          {@render questionPanel(flow.question, "implementation", "flow-question")}
        </div>
      </section>
    {/if}

    <section class="panel" data-testid="flow-pr-section">
      <div class="panel__header">
        <h2 class="panel__title">Pull request</h2>
        <div class="row-sm">
          <CommandButton
            variant="secondary"
            label="Retry PR"
            evidence={() => flow.pr}
            command={() => flow.retryPr()}
            data-command="flow.pr.retry"
            data-testid="retry-flow-pr"
            disabled={flow.prError === null}
          >
            Retry PR
          </CommandButton>
          <CommandButton
            variant="secondary"
            label="Mark ready"
            evidence={() => flow.pr?.state}
            command={() => flow.markPrReady()}
            data-command="flow.pr.ready"
            data-testid="mark-flow-pr-ready"
            title={flow.readyDisabled ? "Only a stopped session with a draft PR can be marked ready." : undefined}
            disabled={flow.readyDisabled}
          >
            Mark ready
          </CommandButton>
          <CommandButton
            variant="default"
            label="Merge"
            evidence={() => flow.pr?.state}
            command={() => flow.mergePr()}
            data-command="flow.pr.merge"
            data-testid="merge-flow-pr"
            title={flow.mergeDisabled ? "Only a stopped session with a live PR can be merged." : undefined}
            disabled={flow.mergeDisabled}
          >
            Merge
          </CommandButton>
        </div>
      </div>
      <div class="panel__body">
        {#if flow.pr === null}
          <p class="empty">No pull request yet.</p>
        {:else}
          <p class="row-sm" data-testid="flow-pr" data-state={flow.pr.state}>
            <span class="muted">Forge</span><span>{flow.pr.forge}</span>
            <span class="muted">Number</span><span class="mono">#{flow.pr.number}</span>
            <span class="muted">State</span><span>{flow.pr.state}</span>
            {#if flow.isHttpUrl(flow.pr.url)}
              <a href={flow.pr.url} target="_blank" rel="noopener noreferrer" data-testid="flow-pr-link">
                {flow.pr.url}
              </a>
            {/if}
          </p>
        {/if}
        {#if flow.prError !== null}
          <p class="message" data-severity="error" data-testid="flow-pr-error" role="alert">
            {flow.prError}
          </p>
        {/if}
        {#if flow.status === "merged" && flow.leftover !== null}
          <p class="muted" data-testid="flow-leftover">{flow.leftover}</p>
        {/if}
      </div>
    </section>

    {#if flow.verification !== null}
      <section class="panel" data-testid="flow-verification" data-status={flow.verification.status}>
        <div class="panel__header">
          <h2 class="panel__title">Verification</h2>
          <span class="badge" data-tone={verificationTone(flow.verification.status)}>
            {flow.verification.status}
          </span>
        </div>
        <div class="panel__body stack-xs">
          <p class="mono" style="margin: 0;">{flow.verification.command}</p>
          <p class="muted" style="margin: 0;">{flow.verification.timestamp}</p>
          <pre class="verification-output">{flow.outputTail(flow.verification.output)}</pre>
        </div>
      </section>
    {/if}

    {@render widgetsSection()}

    <section class="panel" data-testid="flow-files-section">
      <div class="panel__header">
        <h2 class="panel__title">Changed files</h2>
        <span class="muted">{flow.files.length}</span>
      </div>
      <div class="panel__body panel__body--flush">
        {#each flow.files as file (file.path)}
          <Button
            bare
            type="button"
            class="sidebar-item"
            data-testid="flow-file"
            data-path={file.path}
            data-status={file.status}
            data-command={`flow.file.open.${file.path}`}
            onclick={() => openFile(file)}
          >
            <code class="sidebar-item__label">{file.path}</code>
            <span class="badge" data-tone={file.status === "deleted" ? "error" : "accent"}>
              {file.status}
            </span>
            <span class="mono muted">+{file.insertions}/-{file.deletions}</span>
          </Button>
        {:else}
          <p class="empty">No changed files.</p>
        {/each}
      </div>
    </section>

    {#if flow.blockers.length > 0}
      <section class="panel" data-testid="flow-blockers">
        <div class="panel__header"><h2 class="panel__title">Blockers</h2></div>
        <div class="panel__body panel__body--flush">
          {#each flow.blockers as blocker (blocker.id)}
            <div
              class="flow-blocker sidebar-item"
              id={`flow-blocker-${blocker.id}`}
              tabindex="-1"
              data-testid="flow-blocker"
              data-dismissed={blocker.dismissed ? "true" : "false"}
            >
              <span class="mono muted">{blocker.timestamp}</span>
              <span class="sidebar-item__label">{blocker.text}</span>
              {#if blocker.dismissed}
                <span class="badge" data-tone="success">Dismissed</span>
              {:else}
                <CommandButton
                  variant="outline"
                  size="sm"
                  label="Dismiss"
                  evidence={() => flow.blockers}
                  command={() => flow.dismissBlocker(blocker)}
                  data-command={`flow.blocker.dismiss.${blocker.id}`}
                  data-testid="dismiss-flow-blocker"
                >
                  Dismiss
                </CommandButton>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
{/snippet}

<div class="flow-mode mode-body" data-testid="flow-view" data-status={flow.status}>
  {#if tab?.kind === "overview"}
    <AgentActivityBar
      identity={`${layout.mode}:${tab.id}`}
      label="Flow implementation"
      status={overviewBarState}
      activity={overviewBarActivity}
      startedAt={overviewBarStartedAt}
      waiting={overviewBarQuestion !== null}
    >
      {#snippet control()}
        <CommandButton
          variant="default"
          label="Start implementation"
          evidence={() => flow.status}
          command={() => flow.startImplementation()}
          data-command="flow.start"
          data-testid="start-flow-implementation"
          title={flow.startDisabled ? "A flow goal and an idle session are required." : undefined}
          disabled={flow.startDisabled}
        >
          Start implementation
        </CommandButton>
        <CommandButton
          variant="destructive"
          label="Stop implementation"
          evidence={() => flow.status}
          command={() => flow.stopImplementation()}
          data-command="flow.stop"
          data-testid="stop-flow-implementation"
          disabled={flow.stopDisabled}
        >
          Stop implementation
        </CommandButton>
      {/snippet}
    </AgentActivityBar>
  {:else if tab?.kind === "conversation" && flow.conversation !== null}
    <AgentActivityBar
      identity={`${layout.mode}:${tab.id}`}
      label="Widget conversation"
      status="idle"
      activity={flow.conversation.activity}
      waiting={flow.conversation.question !== null}
    />
  {/if}
  {#if flow.errorMessage !== null}
    <p class="message" data-testid="flow-error" data-severity="error" role="alert">
      {flow.errorMessage}
    </p>
  {/if}
  {#if flow.noticeMessage !== null || flow.notice !== null}
    <p class="message" data-testid="flow-notice" data-severity="notice" role="status">
      {flow.noticeMessage ?? flow.notice}
    </p>
  {/if}

  {#if tab === null}
    <p class="empty">No tab is open. Choose a surface from the sidebar.</p>
  {:else if tab.kind === "overview"}
    {@render overview()}
  {:else if tab.kind === "decisions"}
    <div class="scroll-column">
      <section class="panel" data-testid="flow-decisions-section">
        <div class="panel__header flow-decisions__header">
          <div class="flow-decisions__identity">
            <h2 class="panel__title flow-decisions__title">Decision board</h2>
            <span
              class="badge flow-decisions__state"
              data-state={flow.decisions.trim().length > 0 ? "saved" : "empty"}
              data-tone={flow.decisions.trim().length > 0 ? "success" : undefined}
              data-testid="flow-decisions-state"
            >
              {flow.decisions.trim().length > 0 ? "Saved" : "No decisions yet"}
            </span>
          </div>
        </div>
        <div class="panel__body flow-decisions__body">
          <pre class="flow-document__text mono" data-testid="flow-decisions" aria-label="Decision board">{flow.decisions}</pre>
        </div>
      </section>
    </div>
  {:else if tab.kind === "steering"}
    <div class="scroll-column">
      <section class="panel" data-testid="flow-steering">
        <div class="panel__header">
          <h2 class="panel__title">Steering</h2>
          <span
            class="panel__subtitle steering-state"
            data-testid="flow-steering-state"
            data-state={pendingSteering > 0
              ? "waiting"
              : flow.steering.length > 0
                ? "read"
                : "empty"}
          >
            {#if pendingSteering > 0}
              {pendingSteering} note{pendingSteering === 1 ? "" : "s"} waiting for the next checkpoint
            {:else if flow.steering.length > 0}
              All notes read
            {:else}
              Read at the next checkpoint
            {/if}
          </span>
        </div>
        <div class="panel__body stack-sm">
          <div class="steering-composer">
            <textarea
              id="flow-steering-text"
              class="textarea"
              data-testid="flow-steering-text"
              placeholder="Steer the implementation"
              aria-label="Steering note"
              bind:value={flow.steeringDraft}
            ></textarea>
            <div class="steering-composer__actions">
              <CommandButton
                variant="default"
                label="Send"
                evidence={() => flow.steering.length}
                command={() => flow.sendSteering()}
                data-command="flow.steering.send"
                data-testid="send-flow-steering"
                disabled={flow.steeringDraft.trim().length === 0}
              >
                Send
              </CommandButton>
            </div>
          </div>
          {#each flow.steering as note (note.id)}
            <div
              class="steering-note"
              data-testid="flow-steering-note"
              data-status={note.status}
            >
              <div class="steering-meta">
                <span>{note.source}</span>
                <span>{note.timestamp}</span>
                <span>{note.status}</span>
              </div>
              <p style="margin: 2px 0 0;">{note.text}</p>
            </div>
          {:else}
            <p class="empty">No steering notes yet.</p>
          {/each}
        </div>
      </section>
    </div>
  {:else if tab.kind === "history"}
    <div class="scroll-column">
      <section class="panel" data-testid="flow-history">
        <div class="panel__header"><h2 class="panel__title">Past Flow sessions</h2></div>
        <div class="panel__body panel__body--flush">
          {#each flow.history as entry (entry.sessionId)}
            <div class="history-entry" data-testid="flow-history-entry">
              <code>{entry.sessionId}</code>
              <span>{entry.goal}</span>
              {#if entry.pr !== null && flow.isHttpUrl(entry.pr.url)}
                <a href={entry.pr.url} target="_blank" rel="noopener noreferrer">
                  PR #{entry.pr.number}
                </a>
              {:else}
                <span class="muted">no PR</span>
              {/if}
            </div>
          {:else}
            <p class="empty">No past Flow sessions.</p>
          {/each}
        </div>
      </section>
    </div>
  {:else if tab.kind === "widget"}
    {#if activeWidget === null}
      <p class="empty">This change widget is no longer current.</p>
    {:else}
      {@const detailFiles = flow.detailFiles(activeWidget)}
      <DetailSplit id="flow-widget" label="Widget diff">
        {#snippet main()}
          {@render widgetDetail(activeWidget)}
        {/snippet}
        {#snippet detail()}
          <section class="panel" style="height: 100%;">
            <div class="panel__header">
              <h2 class="panel__title">Diff</h2>
              <Button
                variant="outline"
                data-command={`tab.close.flow.${tab.id}`}
                data-testid="close-flow-diff"
                onclick={() => closeTab(tab)}
              >
                Close diff
              </Button>
            </div>
            {@render diffStack(detailFiles)}
          </section>
        {/snippet}
      </DetailSplit>
    {/if}
  {:else if tab.kind === "file"}
    {#if focusedFile === null}
      <p class="empty">This file is no longer part of the change.</p>
    {:else}
      <DetailSplit id="flow-file" label="File diff">
        {#snippet main()}
          <section class="panel" style="height: 100%;">
            <div class="panel__header">
              <h2 class="panel__title mono">{focusedFile.path}</h2>
              <Button
                variant="outline"
                data-command={`tab.close.flow.${tab.id}`}
                data-testid="close-flow-diff"
                onclick={() => closeTab(tab)}
              >
                Close diff
              </Button>
            </div>
            {@render diffStack([focusedFile])}
          </section>
        {/snippet}
        {#snippet detail()}
          <section class="panel" style="height: 100%;">
            <div class="panel__header"><h2 class="panel__title">File</h2></div>
            <div class="panel__body">
              <dl class="kv-grid">
                <dt>Path</dt><dd><code>{focusedFile.path}</code></dd>
                <dt>Status</dt><dd>{focusedFile.status}</dd>
                <dt>Insertions</dt><dd class="mono">+{focusedFile.insertions}</dd>
                <dt>Deletions</dt><dd class="mono">-{focusedFile.deletions}</dd>
              </dl>
              {#if flow.verification !== null}
                <p class="muted" style="margin-top: 8px;">
                  Last verification
                  <span class="badge" data-testid="flow-file-verification" data-tone={verificationTone(flow.verification.status)}>
                    {flow.verification.status}
                  </span>
                </p>
              {/if}
            </div>
          </section>
        {/snippet}
      </DetailSplit>
    {/if}
  {:else if tab.kind === "checkpoint"}
    {#if checkpoint === null}
      <p class="empty">This checkpoint is no longer listed.</p>
    {:else}
      <div class="scroll-column">
        <section class="panel" data-testid="flow-checkpoints">
          <div class="panel__header">
            <h2 class="panel__title">Checkpoint</h2>
            <span class="badge" data-tone={verificationTone(checkpoint.verification)}>
              {checkpoint.verification}
            </span>
          </div>
          <div class="panel__body" data-testid="flow-checkpoint">
            <dl class="kv-grid">
              <dt>Summary</dt><dd>{checkpoint.summary}</dd>
              <dt>Time</dt><dd class="mono">{checkpoint.timestamp}</dd>
              <dt>Files</dt><dd>{checkpoint.files}</dd>
              <dt>Commit</dt><dd><code>{checkpoint.commit}</code></dd>
              <dt>Verification</dt><dd>{checkpoint.verification}</dd>
            </dl>
          </div>
        </section>
      </div>
    {/if}
  {:else if tab.kind === "conversation"}
    {#if flow.conversation === null}
      <p class="empty">No widget conversation is open.</p>
    {:else}
      {@const convo = flow.conversation}
      <DetailSplit id="flow-conversation" label="Conversation diff">
        {#snippet main()}
          <section class="panel" data-testid="flow-conversation" style="height: 100%;">
            <div class="panel__header">
              <h2 class="panel__title">Widget conversation</h2>
              <div class="row-sm">
                <span class="muted" data-testid="flow-conversation-widget">
                  Widget <code>{convo.widgetId}</code>
                </span>
                <CommandButton
                  variant="outline"
                  label="Close"
                  evidence={() => flow.conversation}
                  command={() => flow.closeConversation()}
                  data-command="flow.conversation.close"
                  data-testid="close-flow-conversation"
                >
                  Close
                </CommandButton>
              </div>
            </div>
            <div class="panel__body stack-sm">
              {#if flow.conversationStale}
                <p class="message" data-severity="warning" data-testid="flow-conversation-stale">
                  This change is no longer current. The conversation is read-only, but the
                  conclusion can still be sent.
                </p>
              {/if}
              <div class="stack-xs" data-testid="flow-conversation-messages">
                {#each convo.messages as entry, index (index)}
                  <div class="message" data-role={entry.role}>
                    <div class="notification__meta">{entry.role}</div>
                    <p style="margin: 0;">{entry.text}</p>
                  </div>
                {:else}
                  <p class="empty">No messages yet.</p>
                {/each}
              </div>
              {#if convo.question !== null}
                {@render questionPanel(convo.question, "conversation", "flow-conversation-question")}
              {/if}
              <form
                class="answer-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  conversationSendPending.start();
                  flow.sendConversation();
                }}
              >
                <input
                  class="textarea"
                  style="min-height: 28px; padding: 4px 6px;"
                  type="text"
                  bind:value={flow.conversationDraft}
                  placeholder="Message the conversation"
                  aria-label="Conversation message"
                  data-testid="flow-conversation-input"
                />
                <Button
                  variant="default"
                  type="submit"
                  label="Send"
                  busy={conversationSendPending.busy}
                  data-command="flow.conversation.send"
                  data-testid="send-flow-conversation"
                  disabled={flow.conversationDraft.trim().length === 0}
                >
                  Send
                </Button>
              </form>
              {#if conversationSendPending.notice !== null}
                <CommandNotice
                  text={conversationSendPending.notice}
                  ondismiss={() => conversationSendPending.dismiss()}
                />
              {/if}
              <div class="field">
                <label class="field__label" for="flow-conclusion">Conclusion</label>
                <textarea
                  id="flow-conclusion"
                  class="textarea"
                  data-testid="flow-conclusion"
                  bind:value={flow.conclusionDraft}
                ></textarea>
              </div>
              <div class="row-sm" style="justify-content: flex-end;">
                <CommandButton
                  variant="secondary"
                  label="Send conclusion to implementation"
                  evidence={() => flow.notice}
                  command={() => flow.sendConclusion()}
                  data-command="flow.conclusion.send"
                  data-testid="send-flow-conclusion"
                  disabled={flow.conclusionDraft.trim().length === 0}
                >
                  Send conclusion to implementation
                </CommandButton>
              </div>
            </div>
          </section>
        {/snippet}
        {#snippet detail()}
          <section class="panel" style="height: 100%;">
            <div class="panel__header"><h2 class="panel__title">Widget diff</h2></div>
            {#if conversationWidget === null}
              <p class="empty">The widget is no longer current.</p>
            {:else}
              {@render diffStack(flow.detailFiles(conversationWidget))}
            {/if}
          </section>
        {/snippet}
      </DetailSplit>
    {/if}
  {/if}
</div>
