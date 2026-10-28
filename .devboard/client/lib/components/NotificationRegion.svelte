<script lang="ts">
  import { Dialog } from "bits-ui";
  import X from "lucide-svelte/icons/x";
  import { notificationReport } from "../notification-issue";
  import { notifications, type AppNotification } from "../notifications.svelte";
  import Button from "./ui/button.svelte";

  interface Props {
    feedbackenabled: boolean;
  }

  let { feedbackenabled }: Props = $props();

  const visible = $derived(notifications.items.slice(0, 4));
  /** Bounds shared with the server's report context. */
  const MAX_DOM_EXCERPT = 4000;
  const MAX_VISIBLE_TEXT = 1500;

  /** The notification whose issue is being filed, if any. */
  let filing = $state<number | null>(null);
  /** Filed issue URLs, keyed by notification id. */
  let filed = $state<Record<number, string>>({});
  /** Filing failures, keyed by notification id; an empty value is cleared. */
  let failed = $state<Record<number, string>>({});

  function setHistoryOpen(open: boolean): void {
    if (open) notifications.openHistory();
    else notifications.closeHistory();
  }

  function timestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
  }

  /** Files one notification as a UI issue, with the card as its captured context. */
  async function fileIssue(item: AppNotification, event: MouseEvent): Promise<void> {
    const element = (event.currentTarget as Element | null)?.closest(".notification") ?? null;
    if (element === null || filing !== null || filed[item.id] !== undefined) return;
    filing = item.id;
    failed = { ...failed, [item.id]: "" };
    const payload = {
      action: "report",
      report: notificationReport(item),
      route: window.location.pathname,
      url: window.location.href,
      selector: `.notification[data-notification-id="${item.id}"]`,
      dom_excerpt: (element.outerHTML ?? "").slice(0, MAX_DOM_EXCERPT),
      visible_text: ((element as HTMLElement).innerText ?? element.textContent ?? "").slice(
        0,
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
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `The server refused the report (${response.status}).`,
        );
      }
      filed = { ...filed, [item.id]: body.url };
    } catch (error) {
      failed = {
        ...failed,
        [item.id]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      filing = null;
    }
  }
</script>

{#snippet actions(item: AppNotification)}
  <div class="notification__actions">
    {#if filed[item.id] !== undefined}
      <a
        class="notification__link"
        href={filed[item.id]}
        target="_blank"
        rel="noreferrer"
        title="Open the filed issue"
      >
        Open issue
      </a>
    {:else if feedbackenabled && (item.severity === "error" || item.severity === "warning")}
      <Button
        variant="ghost"
        size="sm"
        class="notification__file"
        aria-label="File an issue from this notification"
        title="File an issue from this notification"
        disabled={filing !== null}
        onclick={(event) => void fileIssue(item, event)}
      >
        {filing === item.id ? "Filing…" : "File issue"}
      </Button>
    {/if}
    <button
      type="button"
      class="workspace-tab__close"
      aria-label="Dismiss notification"
      title="Dismiss notification"
      data-command="app.notifications.dismiss"
      onclick={() => notifications.dismiss(item.id)}
    >
      <X size={12} aria-hidden="true" />
    </button>
  </div>
{/snippet}

<section
  class="notification-region"
  data-testid="notifications"
  aria-label="Notifications"
  aria-live="polite"
>
  {#each visible as item (item.id)}
    <div class="notification" data-severity={item.severity} data-notification-id={item.id}>
      <div class="notification__body">
        <div class="notification__meta">{item.severity} · {timestamp(item.at)}</div>
        <p class="notification__text" role={item.severity === "error" ? "alert" : "status"}>
          {item.text}
        </p>
        {#if failed[item.id]}
          <p class="notification__error" role="alert">Issue not filed: {failed[item.id]}</p>
        {/if}
      </div>
      {@render actions(item)}
    </div>
  {/each}
</section>

<Dialog.Root open={notifications.historyOpen} onOpenChange={setHistoryOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay" />
    <Dialog.Content class="dialog-content" aria-label="Notification history" data-testid="notification-history">
      <div class="dialog-header">
        <Dialog.Title class="dialog-title">Notification history</Dialog.Title>
        <Button variant="ghost" size="sm" onclick={() => notifications.closeHistory()}>
          Close
        </Button>
      </div>
      <div class="dialog-body">
        {#if notifications.items.length === 0}
          <p class="empty">No notifications.</p>
        {:else}
          <div class="history-list">
            {#each notifications.items as item (item.id)}
              <div
                class="notification"
                data-severity={item.severity}
                data-notification-id={item.id}
              >
                <div class="notification__body">
                  <div class="notification__meta">
                    {item.severity} · {timestamp(item.at)}
                  </div>
                  <p class="notification__text">{item.text}</p>
                  {#if failed[item.id]}
                    <p class="notification__error" role="alert">
                      Issue not filed: {failed[item.id]}
                    </p>
                  {/if}
                </div>
                {@render actions(item)}
              </div>
            {/each}
          </div>
        {/if}
      </div>
      <div class="dialog-footer">
        <Button
          variant="outline"
          disabled={notifications.items.length === 0}
          data-command="app.notifications.clear"
          onclick={() => notifications.clear()}
        >
          Clear history
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
