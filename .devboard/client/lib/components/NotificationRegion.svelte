<script lang="ts">
  import { Dialog } from "bits-ui";
  import X from "lucide-svelte/icons/x";
  import { notificationReport } from "../notification-issue";
  import { FEEDBACK_ENDPOINT } from "../../../lib/endpoints.ts";
  import { notifications, type AppNotification } from "../notifications.svelte";
  import Button from "./ui/button.svelte";
  import CommandButton from "./CommandButton.svelte";
  import IconButton from "./ui/icon-button.svelte";

  interface Props {
    feedbackenabled: boolean;
  }

  let { feedbackenabled }: Props = $props();

  const visible = $derived(notifications.live.slice(0, 4));
  /** Bounds shared with the server's report context. */
  const MAX_DOM_EXCERPT = 4000;
  const MAX_VISIBLE_TEXT = 1500;

  /** The notification whose issue is being filed, if any. */
  let filing = $state<number | null>(null);
  /** Filed issue URLs, keyed by notification id. */
  let filed = $state<Record<number, string>>({});
  /** Filing failures, keyed by notification id; an empty value is cleared. */
  let failed = $state<Record<number, string>>({});
  /** Counts each answered filing: the busy word's evidence. */
  let filedSeq = $state(0);

  function setHistoryOpen(open: boolean): void {
    if (open) notifications.openHistory();
    else notifications.closeHistory();
  }

  function timestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
  }

  /** Files one notification as a UI issue, with the card as its captured context. */
  async function fileIssue(item: AppNotification): Promise<void> {
    if (filing !== null || filed[item.id] !== undefined) return;
    const scope = notifications.historyOpen
      ? document.querySelector('[data-testid="notification-history"]')
      : document.querySelector(".notification-region");
    const element =
      scope?.querySelector(`.notification[data-notification-id="${item.id}"]`) ?? null;
    if (element === null) return;
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
      const response = await fetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as {
        url?: unknown;
        detail?: unknown;
      } | null;
      if (!response.ok || typeof body?.url !== "string") {
        throw new Error(
          typeof body?.detail === "string"
            ? body.detail
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
      filedSeq += 1;
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
      <CommandButton
        variant="ghost"
        size="sm"
        label="File issue"
        evidence={() => filedSeq}
        command={() => void fileIssue(item)}
        class="notification__file"
        aria-label="File an issue from this notification"
        title="File an issue from this notification"
        disabled={filing !== null && filing !== item.id}
      >
        File issue
      </CommandButton>
    {/if}
    <IconButton
      label="Dismiss notification"
      command="app.notifications.dismiss"
      class="hover:bg-[var(--secondary-hover)] focus-visible:bg-[var(--secondary-hover)]"
      onclick={() => notifications.dismiss(item.id)}
    >
      <X size={12} aria-hidden="true" />
    </IconButton>
  </div>
{/snippet}

<section
  class="notification-region"
  data-testid="notifications"
  aria-label="Notifications"
  aria-live="polite"
>
  {#each visible as item (item.id)}
    <div
      class="notification"
      data-severity={item.severity}
      data-source={item.source}
      data-notification-id={item.id}
    >
      <div class="notification__body">
        <div class="notification__meta">
          {item.severity} · {item.source} · {timestamp(item.at)}
        </div>
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
                data-source={item.source}
                data-notification-id={item.id}
              >
                <div class="notification__body">
                  <div class="notification__meta">
                    {item.severity} · {item.source} · {timestamp(item.at)}
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
