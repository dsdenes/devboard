<script lang="ts">
  import { onMount } from "svelte";

  /**
   * Operator issue reporter. The floating button starts a selection mode that
   * highlights whatever is under the pointer; picking an element opens a
   * free-text panel anchored beside it. Sending posts the report and the
   * captured DOM context to the server, which files a GitHub issue for an
   * implementation agent and returns its URL.
   */

  type Phase = "idle" | "picking" | "composing" | "sending" | "failed";

  type Rect = { top: number; left: number; width: number; height: number };

  const PANEL_WIDTH = 380;
  const PANEL_ESTIMATED_HEIGHT = 390;
  const GAP = 12;
  const MARGIN = 8;
  const MAX_DOM_EXCERPT = 4000;
  const MAX_VISIBLE_TEXT = 1500;

  let phase = $state<Phase>("idle");
  let target = $state<Element | null>(null);
  let selector = $state("");
  let marker = $state<Rect | null>(null);
  let panel = $state<{ top: number; left: number } | null>(null);
  let report = $state("");
  let errorMessage = $state<string | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);

  let picking = $derived(phase === "picking");
  let sending = $derived(phase === "sending");

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

  function ownOverlay(node: Element | null): boolean {
    return node !== null && node.closest("[data-feedback-overlay]") !== null;
  }

  function elementAt(event: MouseEvent): Element | null {
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

  function openPanel(element: Element): void {
    target = element;
    selector = describeTarget(element);
    const rect = viewportRect(element);
    marker = rect;
    panel = anchorFor(rect);
    report = "";
    errorMessage = null;
    phase = "composing";
    document.body.style.cursor = "";
    queueMicrotask(() => textarea?.focus());
  }

  function reset(): void {
    phase = "idle";
    target = null;
    selector = "";
    marker = null;
    panel = null;
    report = "";
    errorMessage = null;
    document.body.style.cursor = "";
  }

  export function startPicking(): void {
    reset();
    phase = "picking";
    document.body.style.cursor = "crosshair";
  }

  function toggle(): void {
    if (phase === "sending") return;
    if (phase === "idle") {
      startPicking();
      return;
    }
    reset();
  }

  function onPointerMove(event: MouseEvent): void {
    if (!picking) return;
    const element = elementAt(event);
    marker = element === null ? null : viewportRect(element);
  }

  function onPointerDown(event: MouseEvent): void {
    if (!picking) return;
    if (elementAt(event) !== null) event.preventDefault();
  }

  function onClick(event: MouseEvent): void {
    if (!picking) return;
    const element = elementAt(event);
    if (element === null) return;
    // Swallow the click so picking an element never activates it.
    event.preventDefault();
    event.stopPropagation();
    openPanel(element);
  }

  export function cancelReport(): void {
    reset();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || phase === "sending") return;
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
    panel = anchorFor(rect);
  }

  async function send(): Promise<void> {
    if (target === null || report.trim().length === 0 || sending) return;
    const element = target;
    phase = "sending";
    errorMessage = null;
    const payload = {
      report,
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
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok || typeof body?.url !== "string") {
        errorMessage =
          typeof body?.error === "string"
            ? body.error
            : `The server refused the report (${response.status}).`;
        phase = "failed";
        return;
      }
      reset();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      phase = "failed";
    }
  }

  onMount(() => {
    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.body.style.cursor = "";
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

{#if picking}
  <div class="feedback-hint" data-feedback-overlay>Click an element · Esc cancels</div>
{/if}

{#if panel !== null && (phase === "composing" || phase === "sending" || phase === "failed")}
  <div
    class="feedback-panel"
    data-feedback-overlay
    role="dialog"
    aria-label="Report a UI issue"
    style={`top:${panel.top}px;left:${panel.left}px;width:${PANEL_WIDTH}px`}
  >
    <header>
      <strong>Report a UI issue</strong>
      <button
        type="button"
        class="feedback-close"
        aria-label="Close"
        data-command="app.report.cancel"
        onclick={reset}>×</button>
    </header>
    <code class="feedback-selector" title={selector}>{selector}</code>
    <textarea
      bind:this={textarea}
      bind:value={report}
      placeholder="What is wrong with this element?"
      aria-label="Issue description"
      rows="5"
      disabled={sending}
    ></textarea>
    {#if phase === "failed" && errorMessage !== null}
      <p class="feedback-error">{errorMessage}</p>
    {/if}
    <div class="feedback-actions">
      <button type="button" onclick={send} disabled={sending || report.trim().length === 0}>
        {sending ? "Filing…" : "File issue"}
      </button>
      <button
        type="button"
        class="feedback-secondary"
        data-command="app.report.cancel"
        onclick={reset}
        disabled={sending}
      >
        Cancel
      </button>
    </div>
  </div>
{/if}

<button
  type="button"
  class="feedback-button"
  class:feedback-active={phase !== "idle"}
  data-feedback-overlay
  title={picking ? "Cancel element selection" : "Report an issue about a UI element"}
  aria-pressed={picking ? "true" : "false"}
  data-command="app.report"
  disabled={sending}
  onclick={toggle}
>
  {#if picking}
    Cancel selection
  {:else if phase === "composing" || phase === "failed"}
    Cancel report
  {:else if sending}
    Filing…
  {:else}
    Report UI issue
  {/if}
</button>

<style>
  .feedback-button {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    bottom: 2.2rem;
    box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.55rem 1rem;
    position: fixed;
    right: 1.25rem;
    z-index: 2147483647;
  }

  .feedback-button:hover:not(:disabled),
  .feedback-active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .feedback-button:disabled {
    cursor: progress;
    opacity: 0.7;
  }

  .feedback-marker {
    border: 2px solid var(--accent);
    border-radius: 3px;
    box-shadow: 0 0 0 2px rgb(0 0 0 / 0.12);
    pointer-events: none;
    position: fixed;
    z-index: 2147483646;
  }

  .feedback-hint {
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-size: 0.85rem;
    font-weight: 600;
    left: 50%;
    padding: 0.45rem 1rem;
    pointer-events: none;
    position: fixed;
    top: 1rem;
    transform: translateX(-50%);
    z-index: 2147483647;
  }

  .feedback-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 30px rgb(0 0 0 / 0.25);
    color: var(--text);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.9rem;
    position: fixed;
    z-index: 2147483647;
  }

  .feedback-panel header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .feedback-close {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.2rem;
  }

  .feedback-close:hover {
    color: var(--text);
  }

  .feedback-selector {
    color: var(--muted);
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feedback-panel textarea {
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    padding: 0.5rem;
    resize: vertical;
    width: 100%;
  }

  .feedback-panel textarea:focus {
    border-color: var(--accent);
    outline: none;
  }

  .feedback-actions {
    display: flex;
    gap: 0.5rem;
  }

  .feedback-actions button {
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 6px;
    color: var(--surface);
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.4rem 0.8rem;
  }

  .feedback-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .feedback-actions .feedback-secondary {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }

  .feedback-error {
    color: var(--error);
    font-size: 0.8rem;
    margin: 0;
  }
</style>
