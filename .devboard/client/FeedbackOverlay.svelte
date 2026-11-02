<script lang="ts">
  import { onMount, tick } from "svelte";
  import Check from "lucide-svelte/icons/check";
  import TriangleAlert from "lucide-svelte/icons/alert-triangle";
  import X from "lucide-svelte/icons/x";
  import { connection } from "./lib/connection.svelte";
  import { issues } from "./lib/issues.svelte";
  import Button from "./lib/components/ui/button.svelte";
  import CommandButton from "./lib/components/CommandButton.svelte";
  import CommandNotice from "./lib/components/CommandNotice.svelte";
  import { createCommandBusy } from "./lib/command-busy.svelte";
  import type { AskContext, AskTurn, FeedbackAction, FeedbackPhase } from "./lib/types";

  /**
   * Operator issue reporter. The activity bar's three issue actions start a
   * selection mode that highlights whatever is under the pointer. The report
   * action opens a free-text panel anchored beside the picked element; the
   * removal and redesign shortcuts file a fixed-instruction issue for the
   * picked element at once and stay armed. Every filing posts the captured DOM
   * context to the server, which files a GitHub issue for an implementation
   * agent. The component owns the overlay; the shell owns the controls and the
   * armed action.
   *
   * The same panel answers questions: `Ask`, or Enter in the composer, sends
   * the question and the captured context over the WebSocket to a background
   * ACP agent and streams its plain-text answer into the transcript. One
   * conversation belongs to the picked element and lives only while its panel
   * is open.
   */

  type Action = FeedbackAction;
  type Phase = FeedbackPhase;

  type Rect = { top: number; left: number; width: number; height: number };
  type Toast = { ok: boolean; text: string; url?: string };

  const PANEL_WIDTH = 380;
  const PANEL_ESTIMATED_HEIGHT = 390;
  const GAP = 12;
  const MARGIN = 8;
  const MAX_DOM_EXCERPT = 4000;
  const MAX_VISIBLE_TEXT = 1500;
  const MAX_SELECTOR = 500;
  const MAX_ROUTE = 2000;
  const MAX_URL = 2000;
  const MAX_VIEWPORT = 500;
  const MAX_CAPTURED_AT = 100;
  /** Bounds shared with the server's Ask conversation capture. */
  const MAX_CONVERSATION_TURNS = 40;
  const MAX_CONVERSATION_TURN = 4000;
  const MAX_CONVERSATION_TEXT = 12_000;
  /** How long a successful filing toast stays before it dismisses itself. */
  const TOAST_TIMEOUT = 8000;

  let {
    phase = $bindable("idle"),
    action = $bindable<Action | null>(null),
  }: { phase?: Phase; action?: Action | null } = $props();

  const HINTS: Record<Action, string> = {
    report: "Click an element · Esc cancels",
    remove: "Click an element to remove · Esc cancels",
    redesign: "Click an element to redesign · Esc cancels",
  };

  let target = $state<Element | null>(null);
  let selector = $state("");
  let marker = $state<Rect | null>(null);
  let panel = $state<{ top: number; left: number } | null>(null);
  let panelElement = $state<HTMLDivElement | null>(null);
  /** True once the operator has dragged the panel away from its anchor. */
  let moved = $state(false);
  let dragging = $state(false);
  let report = $state("");
  let errorMessage = $state<string | null>(null);
  /** The last filing outcome; outlives `reset()` so cancelling never hides it. */
  let toast = $state<Toast | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let textarea = $state<HTMLTextAreaElement | null>(null);
  /** The one conversation this open panel owns; null before the first ask. */
  let conversationId = $state<string | null>(null);
  let transcript = $state<AskTurn[]>([]);
  let askPending = $state(false);
  let askError = $state<string | null>(null);
  /** The turn in flight; a failed turn returns it to the composer. */
  let askedQuestion = $state("");
  /** Counts each server answer to an Ask turn: the busy word's evidence. */
  let answerSeq = $state(0);
  /** True while the proposed-goal draft is being written. */
  let goalPending = $state(false);
  /** Counts each answered filing or proposal: the busy word's evidence. */
  let filingSeq = $state(0);
  /** Both the Ask button and the composer's Enter path dispatch this command. */
  const askPendingCommand = createCommandBusy({ label: "Ask", evidence: () => answerSeq });
  /**
   * Invalidates the answer to a filing whose panel the operator closed. Every
   * reset bumps it, so a late response writes nothing into a panel that is
   * gone: no re-arm, no phase, no error, no toast.
   */
  let generation = 0;

  const drag = { pointerId: -1, offsetX: 0, offsetY: 0 };

  let sending = $derived(phase === "sending");
  // Every selection mode intercepts clicks; a filing in flight keeps doing so
  // so the click that started it never activates the element it selected.
  let selecting = $derived(
    action !== null && panel === null && (phase === "picking" || phase === "sending"),
  );
  let picking = $derived(selecting && !sending);
  let hint = $derived(action !== null && selecting ? HINTS[action] : null);

  function viewportRect(element: Element): Rect {
    const box = element.getBoundingClientRect();
    return { top: box.top, left: box.left, width: box.width, height: box.height };
  }

  /** Places the panel beside the element, flipping and clamping to stay visible. */
  function anchorFor(rect: Rect): { top: number; left: number } {
    const roomRight = window.innerWidth - rect.left - rect.width - GAP;
    const left =
      roomRight >= PANEL_WIDTH ? rect.left + rect.width + GAP : rect.left - PANEL_WIDTH - GAP;
    return {
      left: Math.min(Math.max(left, MARGIN), window.innerWidth - PANEL_WIDTH - MARGIN),
      top: Math.min(
        Math.max(rect.top, MARGIN),
        Math.max(MARGIN, window.innerHeight - PANEL_ESTIMATED_HEIGHT - MARGIN),
      ),
    };
  }

  /** Keeps a dragged panel on screen, never under the viewport edge. */
  function clampPlacement(top: number, left: number): { top: number; left: number } {
    const height = panelElement?.getBoundingClientRect().height ?? PANEL_ESTIMATED_HEIGHT;
    return {
      left: Math.min(Math.max(left, MARGIN), Math.max(MARGIN, window.innerWidth - PANEL_WIDTH - MARGIN)),
      top: Math.min(Math.max(top, MARGIN), Math.max(MARGIN, window.innerHeight - height - MARGIN)),
    };
  }

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || panel === null) return;
    const origin = event.target instanceof Element ? event.target : null;
    if (origin !== null && origin.closest(".feedback-close") !== null) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    drag.pointerId = event.pointerId;
    drag.offsetX = event.clientX - panel.left;
    drag.offsetY = event.clientY - panel.top;
    dragging = true;
  }

  function moveDrag(event: PointerEvent): void {
    if (!dragging || event.pointerId !== drag.pointerId) return;
    panel = clampPlacement(event.clientY - drag.offsetY, event.clientX - drag.offsetX);
    moved = true;
  }

  function endDrag(event: PointerEvent): void {
    if (event.pointerId !== drag.pointerId) return;
    dragging = false;
    drag.pointerId = -1;
  }

  function moveWithKeys(event: KeyboardEvent): void {
    if (panel === null) return;
    const step = event.shiftKey ? 24 : 8;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-step, 0],
      ArrowDown: [step, 0],
      ArrowLeft: [0, -step],
      ArrowRight: [0, step],
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    panel = clampPlacement(panel.top + move[0], panel.left + move[1]);
    moved = true;
  }

  /**
   * The surfaces that keep working while an action is armed: the overlay's own
   * parts, the activity-bar controls that toggle it, and any dialog. Picking an
   * element never selects them, and a click inside them reaches them.
   */
  function ownOverlay(node: Element | null): boolean {
    return (
      node !== null &&
      (node.closest("[data-feedback-overlay]") !== null ||
        node.closest('[data-command="app.report"]') !== null ||
        node.closest('[data-command="app.remove"]') !== null ||
        node.closest('[data-command="app.redesign"]') !== null ||
        node.closest('[role="dialog"], [role="alertdialog"], dialog') !== null)
    );
  }

  function elementAt(event: MouseEvent): Element | null {
    // Both the event target and the element under the pointer count: a
    // keyboard or scripted activation has no meaningful point.
    if (event.target instanceof Element && ownOverlay(event.target)) return null;
    const node = document.elementFromPoint(event.clientX, event.clientY);
    if (node === null || ownOverlay(node)) return null;
    return node;
  }

  /** A stable-looking selector path for the selected element. */
  function describeTarget(element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node !== null && node !== document.documentElement && parts.length < 12) {
      const name = node.tagName.toLowerCase();
      const id = node.getAttribute("id");
      if (id !== null && id.length > 0 && !id.startsWith("svelte-")) {
        parts.unshift(`#${id}`);
        break;
      }
      const classes = Array.from(node.classList)
        .filter((value) => !value.startsWith("svelte-"))
        .slice(0, 3);
      let part = name + classes.map((value) => `.${value}`).join("");
      const parent = node.parentElement;
      if (parent !== null) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === node?.tagName,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function truncate(value: string, limit: number): string {
    const collapsed = value.replace(/[ \t]+/g, " ").trim();
    if (collapsed.length <= limit) return collapsed;
    return `${collapsed.slice(0, limit - 1)}…`;
  }

  /** The captured context every filing carries. */
  function captured(element: Element): Record<string, string> {
    return {
      route: window.location.pathname,
      url: window.location.href,
      selector,
      dom_excerpt: truncate(element.outerHTML ?? "", MAX_DOM_EXCERPT),
      visible_text: truncate(
        (element as HTMLElement).innerText ?? element.textContent ?? "",
        MAX_VISIBLE_TEXT,
      ),
      viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      captured_at: new Date().toISOString(),
    };
  }

  /** What the ask agent receives; each value is bounded to the server's limit. */
  function captureContext(element: Element): AskContext {
    return {
      route: truncate(window.location.pathname, MAX_ROUTE),
      url: truncate(window.location.href, MAX_URL),
      selector: truncate(selector, MAX_SELECTOR),
      viewport: truncate(
        `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
        MAX_VIEWPORT,
      ),
      captured_at: truncate(new Date().toISOString(), MAX_CAPTURED_AT),
      visible_text: truncate(
        (element as HTMLElement).innerText ?? element.textContent ?? "",
        MAX_VISIBLE_TEXT,
      ),
      dom_excerpt: truncate(element.outerHTML ?? "", MAX_DOM_EXCERPT),
    };
  }

  /** The Ask conversation bounded to the server's limits; the newest turns win. */
  function conversationPayload(): Array<{ role: AskTurn["role"]; text: string }> {
    const turns = transcript
      .slice(-MAX_CONVERSATION_TURNS)
      .map((turn) => ({ role: turn.role, text: truncate(turn.text, MAX_CONVERSATION_TURN) }));
    let total = turns.reduce((sum, turn) => sum + turn.text.length, 0);
    let start = 0;
    while (total > MAX_CONVERSATION_TEXT && start < turns.length - 1) {
      total -= turns[start]?.text.length ?? 0;
      start += 1;
    }
    return turns.slice(start);
  }

  /** Keeps the panel fully inside the viewport after the transcript grows. */
  async function fitPanel(): Promise<void> {
    await tick();
    if (panel === null || panelElement === null) return;
    const height = panelElement.getBoundingClientRect().height;
    const maxTop = Math.max(MARGIN, window.innerHeight - height - MARGIN);
    const top = Math.min(Math.max(panel.top, MARGIN), maxTop);
    if (top !== panel.top) panel = { top, left: panel.left };
  }

  function focusComposer(): void {
    void tick().then(() => textarea?.focus());
  }

  function ask(): void {
    const question = report.trim();
    if (target === null || question.length === 0 || askPending || sending) return;
    const id = conversationId ?? crypto.randomUUID();
    askPendingCommand.start();
    conversationId = id;
    askPending = true;
    askError = null;
    const sent = connection.send({
      type: "ask",
      conversationId: id,
      question,
      context: captureContext(target),
    });
    if (!sent) {
      askPending = false;
      askError = "Not connected to the server.";
      focusComposer();
      return;
    }
    // The question now lives in the transcript: clear the composer at once so
    // the next message never starts from the previous one.
    askedQuestion = question;
    transcript = [...transcript, { role: "developer", text: question }];
    report = "";
    focusComposer();
  }

  /** Enter sends; Shift+Enter and an IME composition keep their newline. */
  function onComposerKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    ask();
  }

  /** Events for a closed or replaced conversation never reach the transcript. */
  function onConnectionMessage(message: Record<string, unknown>): void {
    if (typeof message.conversationId !== "string") return;
    if (message.conversationId !== conversationId) return;

    if (message.type === "askChunk") {
      const text = typeof message.text === "string" ? message.text : "";
      if (text.length === 0 || !askPending) return;
      const last = transcript[transcript.length - 1];
      if (last !== undefined && last.role === "agent") {
        last.text += text;
      } else {
        transcript = [...transcript, { role: "agent", text }];
      }
      return;
    }

    if (message.type === "askDone") {
      askPending = false;
      askError = null;
      askedQuestion = "";
      answerSeq += 1;
      focusComposer();
      return;
    }

    if (message.type === "askError") {
      askPending = false;
      askError =
        typeof message.message === "string" && message.message.length > 0
          ? message.message
          : "The agent could not answer.";
      // A failed turn returns its question to the composer, so one Enter
      // re-asks it and File issue and Goal keep working on the same text.
      if (report.trim().length === 0) report = askedQuestion;
      askedQuestion = "";
      answerSeq += 1;
      focusComposer();
    }
  }

  function openPanel(element: Element): void {
    closeConversation();
    target = element;
    selector = describeTarget(element);
    const rect = viewportRect(element);
    marker = rect;
    panel = anchorFor(rect);
    moved = false;
    dragging = false;
    report = "";
    errorMessage = null;
    action = "report";
    phase = "composing";
    document.body.style.cursor = "";
    queueMicrotask(() => textarea?.focus());
  }

  /** Drops the panel's conversation: no transcript, and the peer is killed. */
  function closeConversation(): void {
    const id = conversationId;
    conversationId = null;
    transcript = [];
    askPending = false;
    askError = null;
    askedQuestion = "";
    if (id !== null && connection.open) {
      connection.send({ type: "closeAsk", conversationId: id });
    }
  }

  /** Shows one outcome toast; a success dismisses itself, an error waits. */
  function showToast(next: Toast): void {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast = next;
    if (next.ok) {
      toastTimer = setTimeout(() => {
        toast = null;
        toastTimer = null;
      }, TOAST_TIMEOUT);
    }
  }

  function dismissToast(): void {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast = null;
  }

  function reset(): void {
    generation += 1;
    closeConversation();
    goalPending = false;
    action = null;
    phase = "idle";
    target = null;
    selector = "";
    marker = null;
    panel = null;
    moved = false;
    dragging = false;
    report = "";
    errorMessage = null;
    document.body.style.cursor = "";
  }

  /** Arms one action: the next click on an element uses it. */
  function arm(next: Action): void {
    reset();
    action = next;
    phase = "picking";
    document.body.style.cursor = "crosshair";
  }

  export function startPicking(): void {
    arm("report");
  }

  export function startRemoving(): void {
    arm("remove");
  }

  export function startRedesigning(): void {
    arm("redesign");
  }

  /** The activity-bar controls: the active action cancels, any other arms. */
  export function toggleAction(next: Action): void {
    if (sending) return;
    if (action === next) {
      reset();
      return;
    }
    arm(next);
  }

  export function toggleReport(): void {
    toggleAction("report");
  }

  function onPointerMove(event: MouseEvent): void {
    if (!picking) return;
    const element = elementAt(event);
    marker = element === null ? null : viewportRect(element);
  }

  function onPointerDown(event: MouseEvent): void {
    if (!selecting) return;
    if (elementAt(event) !== null) event.preventDefault();
  }

  function onClick(event: MouseEvent): void {
    if (!selecting) return;
    const element = elementAt(event);
    if (element === null) return;
    // Swallow the click so picking an element never activates it.
    event.preventDefault();
    event.stopPropagation();
    if (sending) return;
    if (action === "report") {
      openPanel(element);
      return;
    }
    if (action === "remove" || action === "redesign") {
      void fileShortcut(action, element);
    }
  }

  export function cancelReport(): void {
    reset();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || sending || goalPending) return;
    reset();
  }

  function onViewportChange(): void {
    if (phase === "picking") {
      marker = null;
      return;
    }
    if (target === null) return;
    const rect = viewportRect(target);
    marker = rect;
    panel = moved && panel !== null
      ? clampPlacement(panel.top, panel.left)
      : anchorFor(rect);
    void fitPanel();
  }

  /** Posts one submission and returns the filed issue URL, or the error text. */
  async function post(payload: Record<string, unknown>): Promise<
    { ok: true; url: string } | { ok: false; error: string }
  > {
    try {
      const response = await fetch("/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok || typeof body?.url !== "string") {
        return {
          ok: false,
          error:
            typeof body?.error === "string"
              ? body.error
              : `The server refused the report (${response.status}).`,
        };
      }
      return { ok: true, url: body.url };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Files a removal or redesign issue for one element and stays armed. */
  async function fileShortcut(kind: "remove" | "redesign", element: Element): Promise<void> {
    selector = describeTarget(element);
    marker = null;
    dismissToast();
    phase = "sending";
    const response = await post({ action: kind, report: "", ...captured(element) });
    const noun = kind === "remove" ? "Removal" : "Redesign";
    if (response.ok) {
      showToast({ ok: true, text: `${noun} issue filed.`, url: response.url });
    } else {
      showToast({ ok: false, text: `${noun} issue failed: ${response.error}` });
    }
    // The shortcut stays armed so the next element is one click away.
    phase = "picking";
    selector = "";
    document.body.style.cursor = "crosshair";
  }

  /** Writes one proposed-goal draft and returns the draft path, or the error. */
  async function postGoal(
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    try {
      const response = await fetch("/goal-proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as {
        path?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok || typeof body?.path !== "string") {
        return {
          ok: false,
          error:
            typeof body?.error === "string"
              ? body.error
              : `The server refused the proposal (${response.status}).`,
        };
      }
      return { ok: true, path: body.path };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Saves the composer text as a raw goal draft and returns to picking. */
  async function proposeGoal(): Promise<void> {
    if (
      target === null ||
      report.trim().length === 0 ||
      goalPending ||
      sending ||
      askPending
    ) {
      return;
    }
    const element = target;
    const attempt = generation;
    goalPending = true;
    errorMessage = null;
    dismissToast();
    const response = await postGoal({
      report,
      conversation: conversationPayload(),
      ...captured(element),
    });
    if (attempt !== generation) return;
    filingSeq += 1;
    goalPending = false;
    if (!response.ok) {
      errorMessage = response.error;
      phase = "failed";
      return;
    }
    const text = `Goal proposed: ${response.path}`;
    issues.refreshDrafts();
    // Stay in selection mode so the next draft starts with one click.
    arm("report");
    showToast({ ok: true, text });
  }

  async function send(): Promise<void> {
    if (target === null || report.trim().length === 0 || sending) return;
    const element = target;
    const attempt = generation;
    dismissToast();
    phase = "sending";
    errorMessage = null;
    const response = await post({
      action: "report",
      report,
      conversation: conversationPayload(),
      ...captured(element),
    });
    if (attempt !== generation) return;
    filingSeq += 1;
    if (!response.ok) {
      errorMessage = response.error;
      phase = "failed";
      return;
    }
    // Stay in selection mode so the next report starts with one click.
    arm("report");
    showToast({ ok: true, text: "Report filed.", url: response.url });
  }

  // A dropped socket owns no conversation; the server kills its peer.
  $effect(() => {
    if (connection.state === "closed" && conversationId !== null) closeConversation();
  });

  // Measure after every transcript change so the panel never grows past the viewport.
  $effect(() => {
    void transcript.length;
    void transcript[transcript.length - 1]?.text.length;
    void askPending;
    void askError;
    void fitPanel();
  });

  onMount(() => {
    connection.onMessage(onConnectionMessage);
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.body.style.cursor = "";
      if (toastTimer !== null) clearTimeout(toastTimer);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  });
</script>

{#if marker !== null && phase !== "idle"}
  <div
    class="feedback-marker"
    data-feedback-overlay
    style={`top:${marker.top}px;left:${marker.left}px;width:${marker.width}px;` +
      `height:${marker.height}px`}
  ></div>
{/if}

{#if hint !== null}
  <div class="feedback-hint" data-feedback-overlay>{hint}</div>
{/if}

{#if panel !== null && (phase === "composing" || phase === "sending" || phase === "failed")}
  <div
    class="feedback-panel"
    class:feedback-panel--dragging={dragging}
    data-feedback-overlay
    role="dialog"
    aria-label="Report a UI issue"
    style={`top:${panel.top}px;left:${panel.left}px;width:${PANEL_WIDTH}px`}
    bind:this={panelElement}
  >
    <header>
      <Button
        bare
        class="feedback-drag"
        aria-label="Move the report panel"
        title="Drag to move, or use the arrow keys"
        onpointerdown={startDrag}
        onpointermove={moveDrag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onkeydown={moveWithKeys}
      >
        <strong>Report a UI issue</strong>
      </Button>
      <Button
        bare
        class="feedback-close"
        aria-label="Close"
        data-command="app.report.cancel"
        onclick={reset}>×</Button>
    </header>
    <code class="feedback-selector" title={selector}>{selector}</code>
    {#if transcript.length > 0}
      <ul class="feedback-transcript" role="log" aria-label="Ask conversation" aria-live="polite">
        {#each transcript as turn, index (index)}
          <li class="feedback-message" data-role={turn.role}>
            <span class="feedback-message__who" aria-hidden="true">
              {turn.role === "developer" ? "You" : "Agent"}
            </span>
            <p
              class="feedback-turn"
              class:feedback-turn--developer={turn.role === "developer"}
              class:feedback-turn--agent={turn.role === "agent"}
            >{turn.text}</p>
          </li>
        {/each}
      </ul>
    {/if}
    <textarea
      bind:this={textarea}
      bind:value={report}
      placeholder="What is wrong with this element?"
      aria-label="Issue description"
      rows="5"
      disabled={sending || askPending}
      onkeydown={onComposerKeyDown}
    ></textarea>
    {#if askPending}
      <p class="feedback-status" role="status">Asking…</p>
    {/if}
    {#if askError !== null}
      <p class="feedback-error" role="alert">{askError}</p>
    {/if}
    {#if phase === "failed" && errorMessage !== null}
      <p class="feedback-error">{errorMessage}</p>
    {/if}
    <div class="feedback-actions">
      <CommandButton
        bare
        class="feedback-primary"
        label="File issue"
        evidence={() => filingSeq}
        command={() => void send()}
        disabled={askPending || goalPending || report.trim().length === 0}
      >
        File issue
      </CommandButton>
      <Button
        bare
        data-testid="feedback-ask"
        aria-label="Ask the agent about this element"
        label="Ask"
        busy={askPendingCommand.busy}
        onclick={() => ask()}
        disabled={sending || goalPending || report.trim().length === 0}
      >
        Ask
      </Button>
      <CommandButton
        bare
        data-testid="feedback-goal"
        aria-label="Goal: propose a draft from this element"
        label="Goal"
        busyLabel="Saving…"
        evidence={() => filingSeq}
        command={() => void proposeGoal()}
        disabled={sending || askPending || report.trim().length === 0}
      >
        Goal
      </CommandButton>
      <Button
        bare
        data-command="app.report.cancel"
        onclick={reset}
        disabled={sending || goalPending}
      >
        Cancel
      </Button>
    </div>
    {#if askPendingCommand.notice !== null}
      <CommandNotice
        text={askPendingCommand.notice}
        ondismiss={() => askPendingCommand.dismiss()}
      />
    {/if}
  </div>
{/if}

{#if toast !== null}
  <div
    class="feedback-result"
    class:feedback-result--error={!toast.ok}
    data-feedback-overlay
    data-testid="feedback-result"
    role={toast.ok ? "status" : "alert"}
  >
    <span class="feedback-result__icon" aria-hidden="true">
      {#if toast.ok}
        <Check size={14} />
      {:else}
        <TriangleAlert size={14} />
      {/if}
    </span>
    <div class="feedback-result__body">
      <p class="feedback-result__text">{toast.text}</p>
      {#if toast.ok && toast.url !== undefined}
        <a class="feedback-result__link" href={toast.url} target="_blank" rel="noreferrer">
          Open issue
        </a>
      {/if}
    </div>
    <Button
      bare
      class="feedback-result__close"
      aria-label="Dismiss"
      title="Dismiss"
      onclick={dismissToast}
    >
      <X size={12} aria-hidden="true" />
    </Button>
  </div>
{/if}

<style>
  .feedback-result {
    align-items: flex-start;
    animation: feedback-toast-in 120ms ease-out;
    background: var(--surface-raised);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    bottom: 40px;
    color: var(--foreground);
    display: flex;
    gap: 8px;
    left: 50%;
    max-width: min(460px, calc(100vw - 32px));
    padding: 6px 8px;
    position: fixed;
    transform: translateX(-50%);
    z-index: 2147483647;
  }

  .feedback-result__icon {
    color: var(--success);
    display: flex;
    margin-top: 1px;
  }

  .feedback-result--error .feedback-result__icon {
    color: var(--error);
  }

  .feedback-result--error .feedback-result__text {
    color: var(--error);
  }

  .feedback-result__body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .feedback-result__text {
    font-size: 12px;
    font-weight: 600;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .feedback-result__link {
    color: var(--accent);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  :global(.feedback-result__close) {
    align-items: center;
    background: none;
    border: 0;
    color: var(--muted-foreground);
    cursor: pointer;
    display: flex;
    padding: 2px;
  }

  :global(.feedback-result__close:hover) {
    color: var(--foreground);
  }

  @keyframes feedback-toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .feedback-result {
      animation: none;
    }
  }

  .feedback-marker {
    border: 2px solid var(--accent);
    border-radius: 3px;
    pointer-events: none;
    position: fixed;
    z-index: 2147483646;
  }

  .feedback-hint {
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    left: 50%;
    padding: 6px 16px;
    pointer-events: none;
    position: fixed;
    top: 1rem;
    transform: translateX(-50%);
    z-index: 2147483647;
  }

  .feedback-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--foreground);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    position: fixed;
    z-index: 2147483647;
  }

  .feedback-panel header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  :global(.feedback-drag) {
    align-items: center;
    background: none;
    border: 0;
    border-radius: 4px;
    color: inherit;
    cursor: grab;
    display: flex;
    flex: 1;
    font: inherit;
    gap: 6px;
    min-width: 0;
    padding: 0;
    text-align: left;
    touch-action: none;
    user-select: none;
  }

  :global(.feedback-drag:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }

  :global(.feedback-panel--dragging .feedback-drag) {
    cursor: grabbing;
  }

  :global(.feedback-close) {
    background: none;
    border: none;
    color: var(--muted-foreground);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 0 2px;
  }

  :global(.feedback-close:hover) {
    color: var(--foreground);
  }

  .feedback-selector {
    color: var(--muted-foreground);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feedback-transcript {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    list-style: none;
    margin: 0;
    max-height: 180px;
    overflow-y: auto;
    padding: 8px;
  }

  .feedback-message {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 92%;
  }

  .feedback-message[data-role="developer"] {
    align-items: flex-end;
    align-self: flex-end;
  }

  .feedback-message[data-role="agent"] {
    align-items: flex-start;
    align-self: flex-start;
  }

  .feedback-message__who {
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .feedback-turn {
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--foreground);
    font-size: 12px;
    margin: 0;
    overflow-wrap: anywhere;
    padding: 6px 8px;
    white-space: pre-wrap;
  }

  .feedback-turn--developer {
    background: var(--accent-surface);
    border-color: var(--accent);
  }

  .feedback-turn--agent {
    background: var(--surface-raised);
    border-color: var(--border-subtle);
  }

  .feedback-panel textarea {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--foreground);
    font: inherit;
    font-size: 12px;
    padding: 8px;
    resize: vertical;
    width: 100%;
  }

  .feedback-panel textarea:focus {
    border-color: var(--ring);
    outline: 2px solid var(--ring);
  }

  .feedback-actions {
    display: flex;
    gap: 8px;
  }

  :global(.feedback-actions button) {
    background: var(--secondary);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--foreground);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
  }

  :global(.feedback-actions .feedback-primary) {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--primary-foreground);
  }

  :global(.feedback-actions button:disabled) {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .feedback-status {
    color: var(--muted-foreground);
    font-size: 12px;
    margin: 0;
  }

  .feedback-error {
    color: var(--error);
    font-size: 12px;
    margin: 0;
  }
</style>
