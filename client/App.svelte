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

  let records = $state<AdrRecord[]>([]);
  let next = $state<string | null>(null);
  let connection = $state<"connecting" | "open" | "closed">("connecting");
  let error = $state<string | null>(null);

  let pendingCount = $derived(records.filter((record) => record.pending).length);
  let resolvedCount = $derived(records.length - pendingCount);

  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
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
      } else if (isErrorEvent(message)) {
        error = message.message;
      }
    };

    current.onerror = () => {
      error = "Could not reach the server.";
    };

    current.onclose = () => {
      connection = "closed";
      if (!disposed) retryTimer = setTimeout(connect, 1000);
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
    <h1>Architecture Decision Records</h1>
    <p class="summary">
      {resolvedCount} resolved
      <span class="dot" aria-hidden="true">·</span>
      {pendingCount} pending
    </p>
  </header>

  {#if connection !== "open"}
    <p class="connection" role="status">
      {connection === "connecting" ? "Connecting to the server…" : "Connection lost. Reconnecting…"}
    </p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
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
          data-testid="record"
          data-file={record.file}
          data-pending={record.pending}
          data-next={next === record.file}
        >
          <div class="record-heading">
            <h2>{record.title}</h2>
            {#if next === record.file}
              <span class="next-marker" data-testid="next-marker" aria-label="Next record to resolve">
                Next
              </span>
            {/if}
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
