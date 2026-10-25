export type Severity = "error" | "warning" | "notice" | "success";

export interface AppNotification {
  id: number;
  severity: Severity;
  text: string;
  at: string;
}

const HISTORY_LIMIT = 200;

/**
 * Server errors, notices, and client connection failures. The newest entries
 * render in the live notification region; every entry stays in the history
 * opened from the status bar.
 */
export class NotificationStore {
  items = $state<AppNotification[]>([]);
  unread = $state(0);
  historyOpen = $state(false);
  private counter = 0;

  push(severity: Severity, text: string): void {
    const message = text.trim();
    if (message.length === 0) return;
    this.counter += 1;
    this.items = [
      {
        id: this.counter,
        severity,
        text: message,
        at: new Date().toISOString(),
      },
      ...this.items,
    ].slice(0, HISTORY_LIMIT);
    this.unread += 1;
  }

  dismiss(id: number): void {
    this.items = this.items.filter((item) => item.id !== id);
  }

  clear(): void {
    this.items = [];
    this.unread = 0;
  }

  markRead(): void {
    this.unread = 0;
  }

  openHistory(): void {
    this.historyOpen = true;
    this.markRead();
  }

  closeHistory(): void {
    this.historyOpen = false;
  }
}

export const notifications = new NotificationStore();
