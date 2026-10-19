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

  let records = $state<AdrRecord[]>([]);
  let next = $state<string | null>(null);
  let connection = $state<"connecting" | "open" | "closed">("connecting");
  let error = $state<string | null>(null);

  let runFile = $state<string | null>(null);
  let runTitle = $state<string | null>(null);
  let runState = $state<"idle" | "active" | "stopped">("idle");
  let activity = $state<string[]>([]);
  let question = $state<RunQuestion | null>(null);
  let draft = $state("");

  let pendingCount = $derived(records.filter((record) => record.pending).length);
  let resolvedCount = $derived(records.length - pendingCount);
  let running = $derived(runState === "active");

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

  function isActivityEvent(value: unknown): value is { type: "activity"; text: string } {
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

  function start(target?: string) {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return;
    }
    error = null;
    socket.send(JSON.stringify(target === undefined ? { type: "startRun" } : { type: "startRun", file: target }));
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
    };

    current.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (isRecordsEvent(message)) {
        records = message.records;
        next = message.next;
      } else if (isRunStartedEvent(message)) {
        runFile = message.file;
        runTitle = message.title;
        runState = "active";
        activity = [];
        question = null;
        draft = "";
        error = null;
      } else if (isActivityEvent(message)) {
        activity = [...activity, message.text];
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
      <button
        class="start-button"
        data-testid="start-next"
        disabled={running}
        onclick={() => start()}
      >
        Start
      </button>
    </div>
  </header>

  {#if connection !== "open"}
    <p class="connection" role="status">
      {connection === "connecting" ? "Connecting to the server…" : "Connection lost. Reconnecting…"}
    </p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
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
    <section class="activity">
      <h2>Activity</h2>
      <ol class="activity-log" data-testid="activity-log">
        {#each activity as line, index (index)}
          <li>{line}</li>
        {/each}
      </ol>
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
                  disabled={running}
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
