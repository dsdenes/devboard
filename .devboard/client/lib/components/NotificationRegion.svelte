<script lang="ts">
  import { Dialog } from "bits-ui";
  import X from "lucide-svelte/icons/x";
  import { notifications } from "../notifications.svelte";
  import Button from "./ui/button.svelte";

  const visible = $derived(notifications.items.slice(0, 4));

  function setHistoryOpen(open: boolean): void {
    if (open) notifications.openHistory();
    else notifications.closeHistory();
  }

  function timestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
  }
</script>

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
      </div>
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
              <div class="notification" data-severity={item.severity}>
                <div class="notification__body">
                  <div class="notification__meta">
                    {item.severity} · {timestamp(item.at)}
                  </div>
                  <p class="notification__text">{item.text}</p>
                </div>
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
