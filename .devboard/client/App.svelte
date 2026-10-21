<script lang="ts">
  import { onMount } from "svelte";

  interface AdrRecord {
    file: string;
    title: string;
    status: string;
    pending: boolean;
  }

  interface RecordsEvent {
    type: "records";
    records: AdrRecord[];
    next: string | null;
  }

  interface RunQuestion {
    id: number | string;
    message: string;
    choices: string[];
  }

  type LifecycleStage = "goal" | "epic" | "adr" | "implementation" | "finished";

  interface LifecycleWork {
    kind: "adr" | "epic";
    id: string;
  }

  interface LifecycleState {
    stage: LifecycleStage;
    pass: number;
    work: LifecycleWork | null;
    paused: boolean;
  }

  const STAGE_LABELS: Record<LifecycleStage, string> = {
    goal: "Goal setup",
    epic: "Epic generation",
    adr: "ADR resolution",
    implementation: "Implementation",
    finished: "Finished",
  };

  let records = $state<AdrRecord[]>([]);
  let next = $state<string | null>(null);
  let connection = $state<"connecting" | "open" | "closed">("connecting");
  let error = $state<string | null>(null);
  let goalText = $state("");
  let goalReady = $state(false);
  let creationActive = $state(false);

  let runFile = $state<string | null>(null);
  let runTitle = $state<string | null>(null);
  let runState = $state<"idle" | "active" | "stopped">("idle");
  let activity = $state<string[]>([]);
  let question = $state<RunQuestion | null>(null);
  let draft = $state("");
  let revisionActive = $state(false);
  let revisionRequest = $state("");
  let lifecycle = $state<LifecycleState>({ stage: "goal", pass: 1, work: null, paused: false });
  let lifecycleSeen = $state(false);

  let pendingCount = $derived(records.filter((record) => record.pending).length);
  let resolvedCount = $derived(records.length - pendingCount);
  let running = $derived(runState === "active");
  let lifecycleActive = $derived(
    lifecycleSeen &&
      (lifecycle.paused ||
        lifecycle.stage === "adr" ||
        lifecycle.stage === "implementation" ||
        (lifecycle.stage === "epic" && lifecycle.work === null)),
  );
  let controlsDisabled = $derived(running || lifecycleActive || revisionActive || creationActive);
  let revisionDisabled = $derived(
    creationActive || revisionActive || (lifecycleActive ? !lifecycle.paused : running),
  );
  let createDisabled = $derived(revisionDisabled || creationActive || goalReady);
  let goalEditingDisabled = $derived(lifecycleActive && !lifecycle.paused);
  let activityActive = $derived(running || creationActive || revisionActive);
  let currentAction = $derived(activity[activity.length - 1] ?? "");
  let previousActions = $derived(activity.slice(0, -1));
  let previousActionsLabel = $derived(
    previousActions.length === 1
      ? "1 previous action"
      : `${previousActions.length} previous actions`,
  );
  let lifecycleStageLabel = $derived(STAGE_LABELS[lifecycle.stage]);
  let lifecycleWorkTitle = $derived(
    lifecycle.work === null
      ? null
      : lifecycle.work.kind === "epic"
        ? `Epic #${lifecycle.work.id}`
        : (records.find((record) => record.file === lifecycle.work?.id)?.title ??
          lifecycle.work.id),
  );

  let socket: WebSocket | undefined;
  let retryTimer: number | undefined;
  let disposed = false;

  function isRecord(value: unknown): value is AdrRecord {
    return (
      typeof value === "object" &&
      value !== null &&
      "file" in value &&
      typeof value.file === "string" &&
      "title" in value &&
      typeof value.title === "string" &&
      "status" in value &&
      typeof value.status === "string" &&
      "pending" in value &&
      typeof value.pending === "boolean"
    );
  }

  function isRecordsEvent(value: unknown): value is RecordsEvent {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "records" &&
      "records" in value &&
      Array.isArray(value.records) &&
      value.records.every(isRecord) &&
      "next" in value &&
      (value.next === null || typeof value.next === "string")
    );
  }

  function isErrorEvent(value: unknown): value is { type: "error"; message: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "error" &&
      "message" in value &&
      typeof value.message === "string"
    );
  }

  function isGoalEvent(value: unknown): value is { type: "goal"; text: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goal" &&
      "text" in value &&
      typeof value.text === "string"
    );
  }

  function isGoalRevisionStartedEvent(
    value: unknown,
  ): value is { type: "goalRevisionStarted" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalRevisionStarted"
    );
  }

  function isGoalRevisionStoppedEvent(
    value: unknown,
  ): value is { type: "goalRevisionStopped"; completed: boolean; text?: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalRevisionStopped" &&
      "completed" in value &&
      typeof value.completed === "boolean" &&
      (!("text" in value) || typeof value.text === "string")
    );
  }

  function isGoalCreationStartedEvent(
    value: unknown,
  ): value is { type: "goalCreationStarted" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalCreationStarted"
    );
  }

  function isGoalCreationStoppedEvent(
    value: unknown,
  ): value is { type: "goalCreationStopped"; completed: boolean; text?: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalCreationStopped" &&
      "completed" in value &&
      typeof value.completed === "boolean" &&
      (!("text" in value) || typeof value.text === "string")
    );
  }

  function isRunStartedEvent(
    value: unknown,
  ): value is { type: "runStarted"; file: string; title: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "runStarted" &&
      "file" in value &&
      typeof value.file === "string" &&
      "title" in value &&
      typeof value.title === "string"
    );
  }

  function isActivityEvent(
    value: unknown,
  ): value is { type: "activity"; text: string; append?: boolean } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "activity" &&
      "text" in value &&
      typeof value.text === "string"
    );
  }

  function isQuestionEvent(value: unknown): value is { type: "question" } & RunQuestion {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "question" &&
      "id" in value &&
      (typeof value.id === "string" || typeof value.id === "number") &&
      "message" in value &&
      typeof value.message === "string" &&
      "choices" in value &&
      Array.isArray(value.choices) &&
      value.choices.every((choice) => typeof choice === "string")
    );
  }

  function isRunStoppedEvent(
    value: unknown,
  ): value is { type: "runStopped"; file: string; title: string; resolved: boolean; status: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "runStopped" &&
      "file" in value &&
      typeof value.file === "string" &&
      "title" in value &&
      typeof value.title === "string" &&
      "resolved" in value &&
      typeof value.resolved === "boolean" &&
      "status" in value &&
      typeof value.status === "string"
    );
  }

  function isLifecycleStateEvent(
    value: unknown,
  ): value is { type: "lifecycleState" } & LifecycleState {
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      value.type !== "lifecycleState" ||
      !("stage" in value) ||
      !(value.stage in STAGE_LABELS) ||
      !("pass" in value) ||
      typeof value.pass !== "number" ||
      !("work" in value) ||
      !("paused" in value) ||
      typeof value.paused !== "boolean"
    ) {
      return false;
    }

    if (value.work === null) return true;
    return (
      typeof value.work === "object" &&
      value.work !== null &&
      "kind" in value.work &&
      (value.work.kind === "adr" || value.work.kind === "epic") &&
      "id" in value.work &&
      (typeof value.work.id === "string" || typeof value.work.id === "number")
    );
  }

  function start(target?: string) {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    socket.send(JSON.stringify(target === undefined ? { type: "startRun" } : { type: "startRun", file: target }));
  }

  function startLifecycle() {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    socket.send(JSON.stringify({ type: "startLifecycle" }));
  }

  function pauseLifecycle() {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    socket.send(JSON.stringify({ type: "pauseLifecycle" }));
  }

  function resumeLifecycle() {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    socket.send(JSON.stringify({ type: "resumeLifecycle" }));
  }

  function saveGoal() {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    socket.send(JSON.stringify({ type: "saveGoal", text: goalText }));
  }

  function createGoal() {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    socket.send(JSON.stringify({ type: "createGoal" }));
  }

  function reviseGoal() {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    const request = revisionRequest.trim();
    socket.send(
      JSON.stringify(request.length === 0 ? { type: "reviseGoal" } : { type: "reviseGoal", request }),
    );
  }

  function submitAnswer(value: string) {
    if (question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    const id = question.id;
    question = null;
    draft = "";
    socket?.send(JSON.stringify({ type: "answer", id, value: trimmed }));
  }

  function connect() {
    connection = "connecting";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${protocol}//${location.host}/ws`);
    socket = current;

    current.onopen = () => {
      connection = "open";
      error = null;
      current.send(JSON.stringify({ type: "listRecords" }));
      current.send(JSON.stringify({ type: "getGoal" }));
    };

    current.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (isLifecycleStateEvent(message)) {
        lifecycle = {
          stage: message.stage,
          pass: message.pass,
          work:
            message.work === null
              ? null
              : { kind: message.work.kind, id: String(message.work.id) },
          paused: message.paused,
        };
        if (message.stage !== "goal" || message.paused) lifecycleSeen = true;
      } else if (isRecordsEvent(message)) {
        records = message.records;
        next = message.next;
      } else if (isGoalEvent(message)) {
        if (!revisionActive && !creationActive) {
          goalText = message.text;
          goalReady = message.text.trim().length > 0;
        }
        error = null;
      } else if (isGoalCreationStartedEvent(message)) {
        creationActive = true;
        activity = [];
        question = null;
        draft = "";
        error = null;
      } else if (isGoalCreationStoppedEvent(message)) {
        creationActive = false;
        question = null;
        draft = "";
        if (message.completed && typeof message.text === "string") {
          goalText = message.text;
          goalReady = message.text.trim().length > 0;
        }
      } else if (isGoalRevisionStartedEvent(message)) {
        revisionActive = true;
        activity = [];
        question = null;
        draft = "";
        error = null;
      } else if (isGoalRevisionStoppedEvent(message)) {
        revisionActive = false;
        question = null;
        draft = "";
        if (message.completed && typeof message.text === "string") {
          goalText = message.text;
          goalReady = message.text.trim().length > 0;
        }
      } else if (isRunStartedEvent(message)) {
        runFile = message.file;
        runTitle = message.title;
        runState = "active";
        activity = [];
        question = null;
        draft = "";
        error = null;
      } else if (isActivityEvent(message)) {
        if (message.append === true && activity.length > 0) {
          activity = [
            ...activity.slice(0, -1),
            activity[activity.length - 1] + message.text,
          ];
        } else {
          activity = [...activity, message.text];
        }
      } else if (isQuestionEvent(message)) {
        question = { id: message.id, message: message.message, choices: message.choices };
        draft = "";
      } else if (isRunStoppedEvent(message)) {
        runFile = null;
        runTitle = null;
        runState = "stopped";
        question = null;
        draft = "";
      } else if (isErrorEvent(message)) {
        error = message.message;
      }
    };

    current.onerror = () => {
      error = "Could not reach the server.";
    };

    current.onclose = () => {
      connection = "closed";
      if (!disposed) retryTimer = window.setTimeout(connect, 1000);
    };
  }

  onMount(() => {
    connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      socket?.close();
    };
  });
</script>

<main>
  <header class="page-header">
    <div class="heading-row">
      <div>
        <h1>Architecture Decision Records</h1>
        <p class="summary">
          {resolvedCount} resolved
          <span class="dot" aria-hidden="true">·</span>
          {pendingCount} pending
        </p>
      </div>
      <div class="header-actions">
        <button
          type="button"
          class="start-button"
          data-testid="start-lifecycle"
          disabled={controlsDisabled || !goalReady}
          onclick={startLifecycle}
        >
          Start lifecycle
        </button>
        <button
          class="start-button"
          data-testid="start-next"
          disabled={controlsDisabled}
          onclick={() => start()}
        >
          Start
        </button>
      </div>
    </div>
  </header>

  <section class="lifecycle" data-testid="lifecycle">
    <p class="lifecycle-line">
      Stage <strong data-testid="lifecycle-stage">{lifecycleStageLabel}</strong>
    </p>
    <p class="lifecycle-line">
      Pass <strong data-testid="lifecycle-pass">{lifecycle.pass}</strong>
    </p>
    {#if lifecycleWorkTitle !== null}
      <p class="lifecycle-work" data-testid="lifecycle-work">{lifecycleWorkTitle}</p>
    {/if}
    {#if lifecycleActive}
      <div class="lifecycle-controls">
        {#if lifecycle.paused}
          <p class="lifecycle-paused" data-testid="lifecycle-paused">
            Paused at {lifecycleStageLabel}
          </p>
          <button
            type="button"
            class="start-button"
            data-testid="resume-lifecycle"
            disabled={revisionActive}
            onclick={resumeLifecycle}
          >
            Resume lifecycle
          </button>
        {:else}
          <button
            type="button"
            class="start-button"
            data-testid="pause-lifecycle"
            onclick={pauseLifecycle}
          >
            Pause lifecycle
          </button>
        {/if}
      </div>
    {/if}
  </section>

  {#if connection !== "open"}
    <p class="connection" role="status">
      {connection === "connecting" ? "Connecting to the server…" : "Connection lost. Reconnecting…"}
    </p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <section class="goal" data-testid="goal-editor">
    <div class="goal-heading">
      <label class="goal-label" for="goal-text">Current goal</label>
      <p class="goal-state" data-testid="goal-state" aria-live="polite">
        {goalReady ? "Goal ready" : "Goal not set"}
      </p>
      <button
        type="button"
        class="start-button create-goal"
        data-testid="create-goal"
        title={goalReady ? "The goal is already set. Use Revise goal to change it." : undefined}
        disabled={createDisabled}
        onclick={createGoal}
      >
        Create goal
      </button>
    </div>
    <textarea
      id="goal-text"
      class="goal-text"
      bind:value={goalText}
      disabled={goalEditingDisabled}
      data-testid="goal-text"
    ></textarea>
    <button
      type="button"
      class="start-button save-goal"
      data-testid="save-goal"
      disabled={goalEditingDisabled}
      onclick={saveGoal}
    >
      Save goal
    </button>

    <div class="goal-revision">
      <label class="goal-label" for="revision-request">Revision guidance</label>
      <div class="revision-controls">
        <input
          id="revision-request"
          class="revision-request"
          type="text"
          bind:value={revisionRequest}
          placeholder="Optional guidance for the agent"
          data-testid="revision-request"
          disabled={revisionDisabled}
        />
        <button
          type="button"
          class="start-button"
          data-testid="revise-goal"
          disabled={revisionDisabled}
          onclick={reviseGoal}
        >
          Revise goal
        </button>
      </div>
    </div>
  </section>

  {#if creationActive}
    <section class="run active-run" data-testid="goal-creation-active">
      <p class="run-heading">Creating <strong>the goal</strong></p>
    </section>
  {/if}

  {#if revisionActive}
    <section class="run active-run" data-testid="goal-revision-active">
      <p class="run-heading">Revising <strong>the goal</strong></p>
    </section>
  {/if}

  {#if runState === "active" && runTitle !== null}
    <section class="run active-run" data-testid="active-run">
      <p class="run-heading">
        Resolving <strong>{runTitle}</strong>
      </p>
    </section>
  {:else if runState === "stopped"}
    <p class="run stopped-run" data-testid="run-stopped">Run stopped</p>
  {/if}

  {#if activity.length > 0}
    <section class="activity" class:live={activityActive} data-testid="activity">
      <div class="activity-heading">
        <span class="activity-dot" class:live={activityActive} aria-hidden="true"></span>
        <h2>{activityActive ? "Current action" : "Last action"}</h2>
      </div>
      <p class="activity-current" data-testid="activity-current">{currentAction}</p>
      {#if previousActions.length > 0}
        <details class="activity-history">
          <summary data-testid="activity-history">{previousActionsLabel}</summary>
          <ol class="activity-log" data-testid="activity-log">
            {#each [...previousActions].reverse() as line, index (index)}
              <li>{line}</li>
            {/each}
          </ol>
        </details>
      {/if}
    </section>
  {/if}

  {#if question !== null}
    <section class="question" data-testid="question">
      <p class="question-message">{question.message}</p>

      {#if question.choices.length > 0}
        <div class="choices">
          {#each question.choices as choice (choice)}
            <button type="button" data-testid="choice" onclick={() => submitAnswer(choice)}>
              {choice}
            </button>
          {/each}
        </div>
      {/if}

      <form
        class="answer-form"
        onsubmit={(event) => {
          event.preventDefault();
          submitAnswer(draft);
        }}
      >
        <input
          type="text"
          bind:value={draft}
          placeholder="Your answer"
          aria-label="Your answer"
          data-testid="answer-input"
        />
        <button type="submit" data-testid="submit-answer" disabled={draft.trim().length === 0}>
          Submit answer
        </button>
      </form>
    </section>
  {/if}

  {#if records.length === 0}
    <p class="empty">No records found.</p>
  {:else}
    <ul class="records">
      {#each records as record (record.file)}
        <li
          class="record"
          class:pending={record.pending}
          class:resolved={!record.pending}
          class:active={runFile === record.file}
          data-testid="record"
          data-file={record.file}
          data-pending={record.pending}
          data-next={next === record.file}
          data-active={runFile === record.file}
        >
          <div class="record-heading">
            <h2>{record.title}</h2>
            <div class="record-actions">
              {#if next === record.file}
                <span class="next-marker" data-testid="next-marker" aria-label="Next record to resolve">
                  Next
                </span>
              {/if}
              {#if record.pending}
                <button
                  type="button"
                  class="start-button record-start"
                  data-testid="start"
                  data-file={record.file}
                  disabled={controlsDisabled}
                  onclick={() => start(record.file === next ? undefined : record.file)}
                >
                  Start
                </button>
              {/if}
            </div>
          </div>

          <div class="meta">
            <span class="status">{record.status || "Unknown"}</span>
            <span class="state">{record.pending ? "Pending" : "Resolved"}</span>
            <code>{record.file}</code>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</main>
