<script lang="ts">
  import { html as diffHtml } from "diff2html";
  import "diff2html/bundles/css/diff2html.min.css";

  type FlowStatus = "none" | "idle" | "running" | "stopped" | "merged";
  type FlowCategory =
    | "contract"
    | "entity"
    | "naming"
    | "data"
    | "dependency"
    | "irreversible"
    | "structure";
  type AnswerTarget = "goal" | "implementation" | "conversation";

  interface FlowQuestionOption {
    label: string;
    description?: string;
    recommended: boolean;
  }

  interface FlowQuestion {
    id: number | string;
    message: string;
    options: FlowQuestionOption[];
  }

  interface FlowFile {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    insertions: number;
    deletions: number;
    diff: string;
  }

  interface FlowWidget {
    id: string;
    category: FlowCategory;
    concept: string;
    summary: string;
    rationale: string;
    files: string[];
    accepted: boolean;
  }

  interface FlowSteeringNote {
    id: string;
    timestamp: string;
    source: string;
    text: string;
    status: "new" | "read";
  }

  interface FlowCheckpoint {
    id: string;
    timestamp: string;
    summary: string;
    files: number;
    commit: string;
    verification: "passed" | "failed" | "not-run";
  }

  interface FlowVerification {
    command: string;
    status: "passed" | "failed" | "not-run";
    timestamp: string;
    output: string;
  }

  interface FlowBlocker {
    id: string;
    timestamp: string;
    text: string;
    dismissed: boolean;
  }

  interface FlowPr {
    forge: "github" | "gitlab";
    number: number;
    url: string;
    state: "none" | "draft" | "live" | "merged" | "closed" | "error";
  }

  interface FlowConversationMessage {
    role: "developer" | "agent";
    text: string;
  }

  interface FlowConversation {
    widgetId: string;
    messages: FlowConversationMessage[];
    activity: string[];
    question: FlowQuestion | null;
  }

  interface FlowGoalCreation {
    activity: string[];
    question: FlowQuestion | null;
  }

  interface FlowHistoryEntry {
    sessionId: string;
    goal: string;
    pr: FlowPr | null;
  }

  interface FlowSnapshot {
    sessionId: string | null;
    status: FlowStatus;
    goal: string;
    decisions: string;
    worktree: string | null;
    branch: string | null;
    baseRevision: string | null;
    files: FlowFile[];
    widgets: FlowWidget[];
    steering: FlowSteeringNote[];
    checkpoints: FlowCheckpoint[];
    verification: FlowVerification | null;
    blockers: FlowBlocker[];
    pr: FlowPr | null;
    prError: string | null;
    leftover: string | null;
    question: FlowQuestion | null;
    goalCreation: FlowGoalCreation | null;
    conversation: FlowConversation | null;
    activity: string[];
    notice: string | null;
    history: FlowHistoryEntry[];
  }

  const { send }: { send: (command: unknown) => boolean } = $props();

  const DIFF_OPTIONS = {
    outputFormat: "side-by-side" as const,
    drawFileList: false,
    matching: "lines" as const,
  };

  let sessionId = $state<string | null>(null);
  let status = $state<FlowStatus>("none");
  let goal = $state("");
  let decisions = $state("");
  let worktree = $state<string | null>(null);
  let branch = $state<string | null>(null);
  let baseRevision = $state<string | null>(null);
  let files = $state<FlowFile[]>([]);
  let widgets = $state<FlowWidget[]>([]);
  let steering = $state<FlowSteeringNote[]>([]);
  let checkpoints = $state<FlowCheckpoint[]>([]);
  let verification = $state<FlowVerification | null>(null);
  let blockers = $state<FlowBlocker[]>([]);
  let pr = $state<FlowPr | null>(null);
  let prError = $state<string | null>(null);
  let leftover = $state<string | null>(null);
  let question = $state<FlowQuestion | null>(null);
  let goalCreation = $state<FlowGoalCreation | null>(null);
  let conversation = $state<FlowConversation | null>(null);
  let activity = $state<string[]>([]);
  let notice = $state<string | null>(null);
  let history = $state<FlowHistoryEntry[]>([]);
  let errorMessage = $state<string | null>(null);
  let noticeMessage = $state<string | null>(null);

  let goalDraft = $state("");
  let goalDirty = $state(false);
  let decisionsDraft = $state("");
  let decisionsDirty = $state(false);
  let steeringDraft = $state("");
  let conversationDraft = $state("");
  let conclusionDraft = $state("");
  let answers = $state<Record<AnswerTarget, string>>({
    goal: "",
    implementation: "",
    conversation: "",
  });

  let selectedWidgetId = $state<string | null>(null);
  let focusedFile = $state<string | null>(null);
  let refusingId = $state<string | null>(null);
  let refuseReason = $state("");

  let selectedWidget = $derived(
    widgets.find((widget) => widget.id === selectedWidgetId) ?? null,
  );
  let detailFiles = $derived(
    selectedWidget === null
      ? []
      : selectedWidget.files
          .map((path) => files.find((file) => file.path === path))
          .filter((file): file is FlowFile => file !== undefined),
  );
  let focusedFileData = $derived(
    focusedFile === null ? null : (files.find((file) => file.path === focusedFile) ?? null),
  );
  let diffTargets = $derived(focusedFileData === null ? detailFiles : [focusedFileData]);
  let showDiff = $derived(focusedFileData !== null || diffTargets.length > 0);
  let conversationStale = $derived(
    conversation !== null &&
      !widgets.some((widget) => widget.id === conversation?.widgetId),
  );
  let startDisabled = $derived(
    status === "merged" || status === "running" || goal.trim().length === 0,
  );
  let stopDisabled = $derived(status !== "running");
  let readyDisabled = $derived(!(status === "stopped" && pr?.state === "draft"));
  let mergeDisabled = $derived(!(status === "stopped" && pr?.state === "live"));

  function appendLine(lines: string[], text: string, append: boolean): string[] {
    if (append && lines.length > 0) {
      return [...lines.slice(0, -1), lines[lines.length - 1] + text];
    }
    return [...lines, text];
  }

  function applySnapshot(message: FlowSnapshot): void {
    sessionId = message.sessionId;
    status = message.status;
    goal = message.goal;
    decisions = message.decisions;
    worktree = message.worktree;
    branch = message.branch;
    baseRevision = message.baseRevision;
    files = message.files;
    widgets = message.widgets;
    steering = message.steering;
    checkpoints = message.checkpoints;
    verification = message.verification;
    blockers = message.blockers;
    pr = message.pr;
    prError = message.prError;
    leftover = message.leftover;
    question = message.question;
    goalCreation = message.goalCreation;
    conversation = message.conversation;
    activity = message.activity;
    notice = message.notice;
    history = message.history;
    if (!goalDirty) goalDraft = message.goal;
    if (!decisionsDirty) decisionsDraft = message.decisions;
  }

  /** Every parsed server message, including Flow events, arrives here. */
  export function handleEvent(message: unknown): void {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    const type = (message as { type: unknown }).type;
    if (type === "flowSnapshot") {
      applySnapshot(message as unknown as FlowSnapshot);
      return;
    }

    if (type === "flowGoalStarted") {
      goalCreation = { activity: [], question: null };
      errorMessage = null;
      return;
    }
    if (type === "flowGoalStopped") {
      const value = message as { completed?: unknown; text?: unknown };
      goalCreation = null;
      if (value.completed === true && typeof value.text === "string") {
        goal = value.text;
        goalDirty = false;
        goalDraft = value.text;
      }
      return;
    }
    if (type === "flowActivity") {
      const value = message as { text?: unknown; append?: unknown };
      if (typeof value.text !== "string") return;
      const append = value.append === true;
      if (goalCreation !== null) {
        goalCreation = {
          ...goalCreation,
          activity: appendLine(goalCreation.activity, value.text, append),
        };
      } else {
        activity = appendLine(activity, value.text, append);
      }
      return;
    }
    if (type === "flowQuestion") {
      const value = message as {
        target?: unknown;
        id?: unknown;
        message?: unknown;
        options?: unknown;
      };
      if (
        value.id === undefined ||
        (typeof value.id !== "string" && typeof value.id !== "number") ||
        typeof value.message !== "string" ||
        !Array.isArray(value.options)
      ) {
        return;
      }
      const pending: FlowQuestion = {
        id: value.id,
        message: value.message,
        options: value.options as FlowQuestionOption[],
      };
      if (value.target === "goal") {
        goalCreation = {
          activity: goalCreation?.activity ?? [],
          question: pending,
        };
      } else if (value.target === "conversation") {
        if (conversation !== null) conversation = { ...conversation, question: pending };
      } else {
        question = pending;
      }
      return;
    }
    if (type === "flowNotice") {
      const value = message as { message?: unknown };
      if (typeof value.message === "string") notice = value.message;
      return;
    }
    if (type === "flowImplementationStarted") {
      const value = message as {
        sessionId?: unknown;
        worktree?: unknown;
        branch?: unknown;
        baseRevision?: unknown;
      };
      status = "running";
      activity = [];
      if (typeof value.sessionId === "string") sessionId = value.sessionId;
      if (typeof value.worktree === "string") worktree = value.worktree;
      if (typeof value.branch === "string") branch = value.branch;
      if (typeof value.baseRevision === "string") baseRevision = value.baseRevision;
      return;
    }
    if (type === "flowStopped") {
      if (status !== "merged") status = "stopped";
      question = null;
      return;
    }
    if (type === "flowError") {
      const value = message as { message?: unknown };
      if (typeof value.message === "string") errorMessage = value.message;
      return;
    }
    if (type === "flowNotice") {
      const value = message as { message?: unknown };
      if (typeof value.message === "string") noticeMessage = value.message;
      return;
    }
    if (type === "flowFiles") {
      const value = message as { files?: unknown };
      if (Array.isArray(value.files)) files = value.files as FlowFile[];
      return;
    }
    if (type === "flowWidgets") {
      const value = message as { widgets?: unknown };
      if (Array.isArray(value.widgets)) widgets = value.widgets as FlowWidget[];
      return;
    }
    if (type === "flowSteering") {
      const value = message as { notes?: unknown };
      if (Array.isArray(value.notes)) steering = value.notes as FlowSteeringNote[];
      return;
    }
    if (type === "flowDecisions") {
      const value = message as { text?: unknown };
      if (typeof value.text === "string") {
        decisions = value.text;
        if (!decisionsDirty) decisionsDraft = value.text;
      }
      return;
    }
    if (type === "flowCheckpoints") {
      const value = message as { checkpoints?: unknown };
      if (Array.isArray(value.checkpoints)) {
        checkpoints = value.checkpoints as FlowCheckpoint[];
      }
      return;
    }
    if (type === "flowVerification") {
      const value = message as { verification?: unknown };
      verification = (value.verification ?? null) as FlowVerification | null;
      return;
    }
    if (type === "flowBlockers") {
      const value = message as { blockers?: unknown };
      if (Array.isArray(value.blockers)) blockers = value.blockers as FlowBlocker[];
      return;
    }
    if (type === "flowPr") {
      const value = message as { pr?: unknown };
      pr = (value.pr ?? null) as FlowPr | null;
      return;
    }
    if (type === "flowConversationStarted") {
      const value = message as { widgetId?: unknown };
      if (typeof value.widgetId !== "string") return;
      conversation = { widgetId: value.widgetId, messages: [], activity: [], question: null };
      conversationDraft = "";
      conclusionDraft = "";
      return;
    }
    if (type === "flowConversationStopped") {
      const value = message as { widgetId?: unknown };
      if (conversation !== null && value.widgetId === conversation.widgetId) {
        conversation = null;
      }
      return;
    }
    if (type === "flowConversationMessage") {
      const value = message as { role?: unknown; text?: unknown };
      if (
        conversation === null ||
        (value.role !== "developer" && value.role !== "agent") ||
        typeof value.text !== "string"
      ) {
        return;
      }
      conversation = {
        ...conversation,
        messages: [
          ...conversation.messages,
          { role: value.role, text: value.text },
        ],
      };
      return;
    }
    if (type === "flowConversationActivity") {
      const value = message as { text?: unknown; append?: unknown };
      if (conversation === null || typeof value.text !== "string") return;
      conversation = {
        ...conversation,
        activity: appendLine(conversation.activity, value.text, value.append === true),
      };
      return;
    }
    if (type === "flowConversationQuestion") {
      const value = message as { id?: unknown; message?: unknown; options?: unknown };
      if (
        conversation === null ||
        value.id === undefined ||
        (typeof value.id !== "string" && typeof value.id !== "number") ||
        typeof value.message !== "string" ||
        !Array.isArray(value.options)
      ) {
        return;
      }
      conversation = {
        ...conversation,
        question: {
          id: value.id,
          message: value.message,
          options: value.options as FlowQuestionOption[],
        },
      };
    }
  }

  function saveGoal(): void {
    send({ type: "saveFlowGoal", text: goalDraft });
    goalDirty = false;
  }

  function createGoal(): void {
    send({ type: "createFlowGoal" });
  }

  function startImplementation(): void {
    send({ type: "startFlowImplementation" });
  }

  function stopImplementation(): void {
    send({ type: "stopFlowImplementation" });
  }

  function toggleWidget(widget: FlowWidget): void {
    send({ type: "acceptFlowWidget", id: widget.id, accepted: !widget.accepted });
  }

  function openWidget(widget: FlowWidget): void {
    selectedWidgetId = widget.id;
    focusedFile = null;
    refusingId = null;
    refuseReason = "";
  }

  function focusFile(path: string): void {
    selectedWidgetId = null;
    focusedFile = path;
  }

  function startRefuse(widget: FlowWidget): void {
    refusingId = widget.id;
    refuseReason = "";
  }

  function confirmRefuse(widget: FlowWidget): void {
    send({ type: "refuseFlowWidget", id: widget.id, reason: refuseReason });
    refusingId = null;
    refuseReason = "";
  }

  function discuss(widget: FlowWidget): void {
    send({ type: "openFlowWidget", id: widget.id });
  }

  function saveDecisions(): void {
    send({ type: "saveFlowDecisions", text: decisionsDraft });
    decisionsDirty = false;
  }

  function sendSteering(): void {
    const text = steeringDraft;
    if (text.trim().length === 0) return;
    send({ type: "sendFlowSteering", text });
    steeringDraft = "";
  }

  function dismissBlocker(blocker: FlowBlocker): void {
    send({ type: "dismissFlowBlocker", id: blocker.id });
  }

  function answerQuestion(pending: FlowQuestion, value: string, target: AnswerTarget): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    send({ type: "flowAnswer", id: pending.id, value: trimmed, target });
    answers[target] = "";
    if (target === "goal" && goalCreation !== null) {
      goalCreation = { ...goalCreation, question: null };
    } else if (target === "conversation" && conversation !== null) {
      conversation = { ...conversation, question: null };
    } else if (target === "implementation") {
      question = null;
    }
  }

  function sendConversation(): void {
    const text = conversationDraft;
    if (text.trim().length === 0) return;
    send({ type: "sendFlowConversation", text });
    conversationDraft = "";
  }

  function sendConclusion(): void {
    const text = conclusionDraft;
    if (text.trim().length === 0) return;
    send({ type: "sendFlowConclusion", text });
  }

  function closeConversation(): void {
    send({ type: "closeFlowWidget" });
  }

  function retryPr(): void {
    send({ type: "retryFlowPr" });
  }

  function markPrReady(): void {
    send({ type: "markFlowPrReady" });
  }

  function mergePr(): void {
    send({ type: "mergeFlowPr" });
  }

  function outputTail(output: string): string {
    return output.length > 2000 ? `…${output.slice(-2000)}` : output;
  }

  function isHttpUrl(url: string): boolean {
    return url.startsWith("https://") || url.startsWith("http://");
  }
</script>

{#snippet questionPanel(pending: FlowQuestion, target: AnswerTarget, testid: string)}
  <div class="flow-question" data-testid={testid} data-target={target}>
    <p class="flow-question-message">{pending.message}</p>
    {#if pending.options.length > 0}
      <div class="flow-choices">
        {#each pending.options as option (option.label)}
          <button
            type="button"
            class="flow-choice"
            data-testid="flow-choice"
            onclick={() => answerQuestion(pending, option.label, target)}
          >
            <span class="flow-choice-label">
              {option.label}
              {#if option.recommended}
                <span class="flow-recommended">Recommended</span>
              {/if}
            </span>
            {#if option.description}
              <span class="flow-choice-description">{option.description}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
    <form
      class="flow-answer-form"
      onsubmit={(event) => {
        event.preventDefault();
        answerQuestion(pending, answers[target], target);
      }}
    >
      <input
        type="text"
        value={answers[target]}
        oninput={(event) => (answers[target] = event.currentTarget.value)}
        placeholder="Your answer"
        aria-label="Your answer"
        data-testid="flow-answer-input"
      />
      <button
        type="submit"
        data-testid="flow-submit-answer"
        disabled={answers[target].trim().length === 0}
      >
        Submit answer
      </button>
    </form>
  </div>
{/snippet}

<div class="flow-mode" data-testid="flow-view" data-status={status}>
  <div class="flow-banners">
    {#if errorMessage !== null}
      <p class="error flow-error" data-testid="flow-error" role="alert">{errorMessage}</p>
    {/if}
    {#if noticeMessage !== null || notice !== null}
      <p class="flow-notice" data-testid="flow-notice" role="status">
        {noticeMessage ?? notice}
      </p>
    {/if}
  </div>

  <div class="flow-layout">
    <section class="flow-panel" data-testid="flow-goal">
      <div class="flow-panel-heading">
        <h2>Flow goal</h2>
        <button
          type="button"
          class="start-button"
          data-testid="create-flow-goal"
          onclick={createGoal}
        >
          {goal.trim().length > 0 ? "Recreate flow goal" : "Create flow goal"}
        </button>
      </div>
      <textarea
        class="flow-textarea flow-goal-text"
        data-testid="flow-goal-text"
        aria-label="Flow goal"
        bind:value={goalDraft}
        oninput={() => (goalDirty = true)}
      ></textarea>
      <button
        type="button"
        class="start-button"
        data-testid="save-flow-goal"
        onclick={saveGoal}
      >
        Save
      </button>

      {#if goalCreation !== null}
        <div class="flow-creation" data-testid="flow-goal-active">
          <p class="flow-section-title">Goal interview</p>
          <div class="flow-activity" data-testid="flow-goal-activity">
            {#if goalCreation.activity.length === 0}
              <p class="empty">Waiting for the agent…</p>
            {:else}
              <ol class="flow-activity-log">
                {#each goalCreation.activity as line, index (index)}
                  <li>{line}</li>
                {/each}
              </ol>
            {/if}
          </div>
          {#if goalCreation.question !== null}
            {@render questionPanel(goalCreation.question, "goal", "flow-goal-question")}
          {/if}
        </div>
      {/if}
    </section>

    <section class="flow-panel" data-testid="flow-session">
      <h2>Session</h2>
      <div class="flow-meta">
        <p class="flow-meta-row">
          <span class="flow-label">Status</span>
          <span class="flow-state" data-testid="flow-status" data-status={status}>{status}</span>
        </p>
        {#if sessionId !== null}
          <p class="flow-meta-row">
            <span class="flow-label">Session</span>
            <code>{sessionId}</code>
          </p>
        {/if}
        {#if worktree !== null}
          <p class="flow-meta-row">
            <span class="flow-label">Worktree</span>
            <code data-testid="flow-worktree">{worktree}</code>
          </p>
        {/if}
        {#if branch !== null}
          <p class="flow-meta-row">
            <span class="flow-label">Branch</span>
            <code data-testid="flow-branch">{branch}</code>
          </p>
        {/if}
        {#if baseRevision !== null}
          <p class="flow-meta-row">
            <span class="flow-label">Base revision</span>
            <code data-testid="flow-base-revision">{baseRevision}</code>
          </p>
        {/if}
      </div>

      <div class="flow-actions">
        <button
          type="button"
          class="start-button"
          data-testid="start-flow-implementation"
          disabled={startDisabled}
          onclick={startImplementation}
        >
          Start implementation
        </button>
        <button
          type="button"
          class="start-button stop-button"
          data-testid="stop-flow-implementation"
          disabled={stopDisabled}
          onclick={stopImplementation}
        >
          Stop implementation
        </button>
      </div>

      {#if question !== null}
        {@render questionPanel(question, "implementation", "flow-question")}
      {/if}
    </section>
  </div>

  <section class="flow-panel" data-testid="flow-activity-section">
    <h2>Implementation activity</h2>
    <div class="flow-activity" data-testid="flow-activity">
      {#if activity.length === 0}
        <p class="empty">No implementation activity yet.</p>
      {:else}
        <ol class="flow-activity-log">
          {#each activity as line, index (index)}
            <li>{line}</li>
          {/each}
        </ol>
      {/if}
    </div>
  </section>

  <section class="flow-panel" data-testid="flow-pr-section">
    <div class="flow-panel-heading">
      <h2>Pull request</h2>
    </div>
    {#if pr === null}
      <p class="empty">No pull request yet.</p>
    {:else}
      <p class="flow-pr-summary" data-testid="flow-pr" data-state={pr.state}>
        <span class="flow-label">Forge</span>
        <span>{pr.forge}</span>
        <span class="flow-label">Number</span>
        <span>#{pr.number}</span>
        <span class="flow-label">State</span>
        <span>{pr.state}</span>
        {#if isHttpUrl(pr.url)}
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="flow-pr-link"
          >
            {pr.url}
          </a>
        {/if}
      </p>
    {/if}
    {#if prError !== null}
      <p class="error flow-pr-error" data-testid="flow-pr-error" role="alert">{prError}</p>
      <button
        type="button"
        class="start-button"
        data-testid="retry-flow-pr"
        onclick={retryPr}
      >
        Retry PR
      </button>
    {/if}
    <div class="flow-actions">
      <button
        type="button"
        class="start-button"
        data-testid="mark-flow-pr-ready"
        disabled={readyDisabled}
        onclick={markPrReady}
      >
        Mark ready
      </button>
      <button
        type="button"
        class="start-button"
        data-testid="merge-flow-pr"
        disabled={mergeDisabled}
        onclick={mergePr}
      >
        Merge
      </button>
    </div>
    {#if status === "merged" && leftover !== null}
      <p class="flow-leftover" data-testid="flow-leftover">{leftover}</p>
    {/if}
  </section>

  <section class="flow-panel" data-testid="flow-widgets-section">
    <div class="flow-panel-heading">
      <h2>Change widgets</h2>
      <span class="flow-count">{widgets.length}</span>
    </div>
    {#if widgets.length === 0}
      <p class="empty">No change widgets yet.</p>
    {:else}
      <div class="flow-widget-grid">
        {#each widgets as widget (widget.id)}
          <article
            class="flow-widget"
            class:accepted={widget.accepted}
            data-testid="flow-widget"
            data-widget-id={widget.id}
            data-accepted={widget.accepted ? "true" : "false"}
            data-category={widget.category}
            onclick={() => openWidget(widget)}
          >
            <div class="flow-widget-header">
              <span class="flow-widget-badge" data-category={widget.category}>
                {widget.category}
              </span>
              <label class="flow-widget-accept">
                <input
                  type="checkbox"
                  checked={widget.accepted}
                  data-testid="flow-widget-accept"
                  onclick={(event) => event.stopPropagation()}
                  onchange={() => toggleWidget(widget)}
                />
                Accepted
              </label>
            </div>
            <button
              type="button"
              class="flow-widget-body"
              data-testid="flow-widget-open"
              onclick={(event) => {
                event.stopPropagation();
                openWidget(widget);
              }}
            >
              <span class="flow-widget-concept">{widget.concept}</span>
              <span class="flow-widget-summary">{widget.summary}</span>
              <span class="flow-widget-count">
                {widget.files.length}
                {widget.files.length === 1 ? "file" : "files"}
              </span>
            </button>
            <div class="flow-widget-actions">
              <button
                type="button"
                class="start-button"
                data-testid="flow-widget-discuss"
                onclick={(event) => {
                  event.stopPropagation();
                  discuss(widget);
                }}
              >
                Discuss
              </button>
              <button
                type="button"
                class="start-button"
                data-testid="flow-widget-refuse"
                onclick={(event) => {
                  event.stopPropagation();
                  startRefuse(widget);
                }}
              >
                Refuse
              </button>
            </div>
            {#if refusingId === widget.id}
              <div
                class="flow-refuse"
                data-testid="flow-refuse"
                onclick={(event) => event.stopPropagation()}
              >
                <textarea
                  class="flow-textarea"
                  data-testid="refuse-widget-reason"
                  placeholder="Optional reason"
                  aria-label="Reason for refusing this change"
                  bind:value={refuseReason}
                ></textarea>
                <div class="flow-actions">
                  <button
                    type="button"
                    class="start-button stop-button"
                    data-testid="confirm-refuse-widget"
                    onclick={() => confirmRefuse(widget)}
                  >
                    Confirm refuse
                  </button>
                  <button
                    type="button"
                    class="start-button"
                    data-testid="cancel-refuse-widget"
                    onclick={() => (refusingId = null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </section>

  {#if selectedWidget !== null}
    <section
      class="flow-panel flow-widget-detail"
      data-testid="flow-widget-detail"
      data-widget-id={selectedWidget.id}
      data-category={selectedWidget.category}
    >
      <div class="flow-panel-heading">
        <h2>{selectedWidget.concept}</h2>
        <button
          type="button"
          class="start-button"
          data-testid="close-flow-widget-detail"
          onclick={() => (selectedWidgetId = null)}
        >
          Close
        </button>
      </div>
      <p class="flow-widget-badge" data-category={selectedWidget.category}>
        {selectedWidget.category}
      </p>
      <p class="flow-detail-summary">{selectedWidget.summary}</p>
      <p class="flow-detail-rationale">{selectedWidget.rationale}</p>
      <h3>Files</h3>
      <ul class="flow-file-list">
        {#each detailFiles as file (file.path)}
          <li>
            <button
              type="button"
              class="flow-file-link"
              data-testid="flow-widget-file"
              onclick={() => focusFile(file.path)}
            >
              <code>{file.path}</code>
              <span class="flow-file-status" data-status={file.status}>{file.status}</span>
              <span class="flow-file-stats">+{file.insertions}/-{file.deletions}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if files.length > 0}
    <section class="flow-panel" data-testid="flow-files-section">
      <h2>Changed files</h2>
      <ul class="flow-file-map">
        {#each files as file (file.path)}
          <li>
            <button
              type="button"
              class="flow-file-row"
              class:selected={focusedFile === file.path}
              data-testid="flow-file"
              data-path={file.path}
              data-status={file.status}
              onclick={() => focusFile(file.path)}
            >
              <code class="flow-file-path">{file.path}</code>
              <span class="flow-file-status" data-status={file.status}>{file.status}</span>
              <span class="flow-file-stats">
                <span class="flow-insertions">+{file.insertions}</span>
                <span class="flow-deletions">-{file.deletions}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if showDiff}
    <section class="flow-panel flow-diff-panel">
      <div class="flow-panel-heading">
        <h2>Diff</h2>
        <button
          type="button"
          class="start-button"
          data-testid="close-flow-diff"
          onclick={() => {
            focusedFile = null;
            selectedWidgetId = null;
          }}
        >
          Close diff
        </button>
      </div>
      <div class="flow-diff" data-testid="flow-diff">
        {#each diffTargets as file (file.path)}
          <div class="flow-diff-file">
            <p class="flow-diff-path">
              <code>{file.path}</code>
              <span class="flow-file-status" data-status={file.status}>{file.status}</span>
            </p>
            <div class="flow-diff-html">
              {@html diffHtml(file.diff, DIFF_OPTIONS)}
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if verification !== null}
    <section
      class="flow-panel flow-verification"
      class:failed={verification.status === "failed"}
      data-testid="flow-verification"
      data-status={verification.status}
    >
      <div class="flow-panel-heading">
        <h2>Verification</h2>
        <span class="flow-verification-status" data-status={verification.status}>
          {verification.status}
        </span>
      </div>
      <p class="flow-verification-command"><code>{verification.command}</code></p>
      <p class="flow-verification-time">{verification.timestamp}</p>
      <pre class="flow-verification-output">{outputTail(verification.output)}</pre>
    </section>
  {/if}

  {#if checkpoints.length > 0}
    <section class="flow-panel" data-testid="flow-checkpoints">
      <h2>Checkpoints</h2>
      <ul class="flow-checkpoint-list">
        {#each checkpoints as checkpoint (checkpoint.id)}
          <li class="flow-checkpoint" data-testid="flow-checkpoint">
            <span class="flow-checkpoint-time">{checkpoint.timestamp}</span>
            <span class="flow-checkpoint-summary">{checkpoint.summary}</span>
            <span class="flow-checkpoint-files">
              {checkpoint.files}
              {checkpoint.files === 1 ? "file" : "files"}
            </span>
            <code class="flow-checkpoint-commit">{checkpoint.commit}</code>
            <span
              class="flow-verification-status"
              data-status={checkpoint.verification}
            >
              {checkpoint.verification}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="flow-layout">
    <section class="flow-panel" data-testid="flow-steering">
      <h2>Steering</h2>
      <textarea
        class="flow-textarea"
        data-testid="flow-steering-text"
        placeholder="Steer the implementation"
        aria-label="Steering note"
        bind:value={steeringDraft}
      ></textarea>
      <button
        type="button"
        class="start-button"
        data-testid="send-flow-steering"
        disabled={steeringDraft.trim().length === 0}
        onclick={sendSteering}
      >
        Send
      </button>
      {#if steering.length > 0}
        <ul class="flow-steering-list">
          {#each steering as note (note.id)}
            <li
              class="flow-steering-note"
              data-testid="flow-steering-note"
              data-status={note.status}
            >
              <div class="flow-steering-meta">
                <span class="flow-steering-source">{note.source}</span>
                <span class="flow-steering-time">{note.timestamp}</span>
                <span class="flow-steering-status">{note.status}</span>
              </div>
              <p class="flow-steering-text">{note.text}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="flow-panel" data-testid="flow-decisions-section">
      <h2>Decision board</h2>
      <textarea
        class="flow-textarea flow-decisions-text"
        data-testid="flow-decisions"
        aria-label="Decision board"
        bind:value={decisionsDraft}
        oninput={() => (decisionsDirty = true)}
      ></textarea>
      <button
        type="button"
        class="start-button"
        data-testid="save-flow-decisions"
        onclick={saveDecisions}
      >
        Save
      </button>
    </section>
  </div>

  {#if blockers.length > 0}
    <section class="flow-panel" data-testid="flow-blockers">
      <h2>Blockers</h2>
      <ul class="flow-blocker-list">
        {#each blockers as blocker (blocker.id)}
          <li
            class="flow-blocker"
            class:dismissed={blocker.dismissed}
            data-testid="flow-blocker"
            data-dismissed={blocker.dismissed ? "true" : "false"}
          >
            <span class="flow-blocker-time">{blocker.timestamp}</span>
            <span class="flow-blocker-text">{blocker.text}</span>
            {#if blocker.dismissed}
              <span class="flow-blocker-dismissed">Dismissed</span>
            {:else}
              <button
                type="button"
                class="start-button"
                data-testid="dismiss-flow-blocker"
                onclick={() => dismissBlocker(blocker)}
              >
                Dismiss
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if conversation !== null}
    {@const convo = conversation}
    <section class="flow-panel flow-conversation" data-testid="flow-conversation">
      <div class="flow-panel-heading">
        <h2>Widget conversation</h2>
        <button
          type="button"
          class="start-button"
          data-testid="close-flow-conversation"
          onclick={closeConversation}
        >
          Close
        </button>
      </div>
      <p class="flow-conversation-widget" data-testid="flow-conversation-widget">
        Widget <code>{convo.widgetId}</code>
      </p>
      {#if conversationStale}
        <p class="flow-stale" data-testid="flow-conversation-stale">
          This change is no longer current. The conversation is read-only, but the
          conclusion can still be sent.
        </p>
      {/if}

      <div class="flow-messages" data-testid="flow-conversation-messages">
        {#each convo.messages as entry, index (index)}
          <div class="flow-message" data-role={entry.role}>
            <span class="flow-message-role">{entry.role}</span>
            <p class="flow-message-text">{entry.text}</p>
          </div>
        {/each}
      </div>

      <div class="flow-activity" data-testid="flow-conversation-activity">
        {#if convo.activity.length > 0}
          <ol class="flow-activity-log">
            {#each convo.activity as line, index (index)}
              <li>{line}</li>
            {/each}
          </ol>
        {/if}
      </div>

      {#if convo.question !== null}
        {@render questionPanel(convo.question, "conversation", "flow-conversation-question")}
      {/if}

      <form
        class="flow-answer-form"
        onsubmit={(event) => {
          event.preventDefault();
          sendConversation();
        }}
      >
        <input
          type="text"
          bind:value={conversationDraft}
          placeholder="Message the conversation"
          aria-label="Conversation message"
          data-testid="flow-conversation-input"
        />
        <button
          type="submit"
          data-testid="send-flow-conversation"
          disabled={conversationDraft.trim().length === 0}
        >
          Send
        </button>
      </form>

      <label class="flow-label" for="flow-conclusion">Conclusion</label>
      <textarea
        id="flow-conclusion"
        class="flow-textarea"
        data-testid="flow-conclusion"
        bind:value={conclusionDraft}
      ></textarea>
      <button
        type="button"
        class="start-button"
        data-testid="send-flow-conclusion"
        disabled={conclusionDraft.trim().length === 0}
        onclick={sendConclusion}
      >
        Send conclusion to implementation
      </button>
    </section>
  {/if}

  {#if history.length > 0}
    <section class="flow-panel" data-testid="flow-history">
      <h2>Past Flow sessions</h2>
      <ul class="flow-history-list">
        {#each history as entry (entry.sessionId)}
          <li class="flow-history-entry" data-testid="flow-history-entry">
            <code>{entry.sessionId}</code>
            <span class="flow-history-goal">{entry.goal}</span>
            {#if entry.pr !== null && isHttpUrl(entry.pr.url)}
              <a href={entry.pr.url} target="_blank" rel="noopener noreferrer">
                PR #{entry.pr.number}
              </a>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
