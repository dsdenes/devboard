<script lang="ts">
  import { Dialog } from "bits-ui";
  import X from "lucide-svelte/icons/x";
  import {
    notificationFiler,
    REPORTING_DISABLED_DETAIL,
    type NotificationContext,
    type NotificationFiling,
  } from "../notification-issue";
  import { notifications, type AppNotification } from "../notifications.svelte";
  import { slowUiAction } from "../slow-ui-action";
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

  /** Filed issue URLs, keyed by notification id, for warnings and retries. */
  let filed = $state<Record<number, string>>({});
  /** Manual filing failures, keyed by notification id; an empty value is cleared. */
  let failed = $state<Record<number, string>>({});
  /** The notification whose manual filing is in flight, if any. */
  let filing = $state<number | null>(null);
  /** Counts each answered manual filing: the busy word's evidence. */
  let filedSeq = $state(0);

  function setHistoryOpen(open: boolean): void {
    if (open) notifications.openHistory();
    else notifications.closeHistory();
  }

  function timestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
  }

  /**
   * Files every error notification raised in this page session without a
   * click. An identity that already has an outcome is skipped, so the same
   * error twice links to the one issue and posts nothing more.
   */
  $effect(() => {
    if (!feedbackenabled) return;
    for (const item of notifications.items) {
      if (item.severity !== "error") continue;
      if (notificationFiler.state(item) !== undefined) continue;
      void notificationFiler.autoFile(item, () => captureContext(item));
    }
  });

  /**
   * The card's page context, shaped exactly like the manual report's: the
   * card itself when it is on screen, the live region when it is not.
   */
  function captureContext(item: AppNotification): NotificationContext {
    const selector = `.notification[data-notification-id="${item.id}"]`;
    const card = document.querySelector(selector);
    const target = card ?? document.querySelector(".notification-region") ?? document.body;
    return {
      route: window.location.pathname,
      url: window.location.href,
      selector: card === null ? ".notification-region" : selector,
      domExcerpt: (target.outerHTML ?? "").slice(0, MAX_DOM_EXCERPT),
      visibleText: ((target as HTMLElement).innerText ?? target.textContent ?? "").slice(
        0,
        MAX_VISIBLE_TEXT,
      ),
      viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      capturedAt: new Date().toISOString(),
    };
  }

  /** Files one notification by hand: the warning button and the error retry. */
  async function fileIssue(item: AppNotification): Promise<void> {
    if (item.issue !== undefined) {
      await slowUiAction.retry(item.id);
      filedSeq += 1;
      return;
    }
    if (item.severity === "error") {
      await notificationFiler.file(item, () => captureContext(item));
      filedSeq += 1;
      return;
    }
    if (filing !== null || filed[item.id] !== undefined) return;
    filing = item.id;
    const outcome = await notificationFiler.submit(item, () => captureContext(item));
    if (outcome.status === "filed") {
      filed = { ...filed, [item.id]: outcome.href };
      failed = { ...failed, [item.id]: "" };
    } else if (outcome.status === "failed") {
      failed = { ...failed, [item.id]: outcome.detail };
    }
    filing = null;
    filedSeq += 1;
  }

  /** The error card's shared automatic outcome, if it has one. */
  function errorFiling(item: AppNotification): NotificationFiling | undefined {
    return item.severity === "error" ? notificationFiler.state(item) : undefined;
  }

  /** Why this card names no issue, if it does. */
  function failureDetail(item: AppNotification): string | null {
    if (item.issue?.status === "failed") return item.issue.detail;
    if (item.issue?.status === "disabled") return REPORTING_DISABLED_DETAIL;
    if (item.issue !== undefined) return null;
    if (item.severity === "error") {
      const outcome = errorFiling(item);
      if (outcome?.status === "failed") return outcome.detail;
      if (outcome === undefined && !feedbackenabled) return REPORTING_DISABLED_DETAIL;
      return null;
    }
    const detail = failed[item.id];
    return detail === undefined || detail === "" ? null : detail;
  }

  /** The filed issue this card links to, from the shared or the manual state. */
  function issueHref(item: AppNotification): string | undefined {
    if (item.issue !== undefined) {
      return item.issue.status === "filed" ? item.issue.href : undefined;
    }
    if (item.severity === "error") {
      const outcome = errorFiling(item);
      return outcome?.status === "filed" ? outcome.href : undefined;
    }
    return filed[item.id];
  }

  /** Whether this card offers the manual filing button. */
  function showsFilingButton(item: AppNotification): boolean {
    if (item.issue !== undefined) return item.issue.status === "failed";
    if (item.severity === "error") {
      const outcome = errorFiling(item);
      return outcome === undefined ? !feedbackenabled : outcome.status === "failed";
    }
    return item.severity === "warning" && feedbackenabled;
  }
</script>

{#snippet card(item: AppNotification)}
  {@const href = issueHref(item)}
  {@const detail = failureDetail(item)}
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
      {#if detail !== null}
        <p class="notification__error" role="alert">Issue not filed: {detail}</p>
      {/if}
    </div>
    <div class="notification__actions">
      {#if href !== undefined}
        <a
          class="notification__link"
          {href}
          target="_blank"
          rel="noreferrer"
          title="Open the filed issue"
        >
          Open issue
        </a>
      {:else if showsFilingButton(item)}
        <CommandButton
          variant="ghost"
          size="sm"
          label="File issue"
          evidence={() => filedSeq}
          command={() => void fileIssue(item)}
          class="notification__file"
          aria-label="File an issue from this notification"
          title="File an issue from this notification"
          disabled={filing !== null}
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
  </div>
{/snippet}

<section
  class="notification-region"
  data-testid="notifications"
  aria-label="Notifications"
  aria-live="polite"
>
  {#each visible as item (item.id)}
    {@render card(item)}
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
              {@render card(item)}
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
