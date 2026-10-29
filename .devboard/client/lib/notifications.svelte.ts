export type Severity = "error" | "warning" | "notice" | "success";

/** How long a card stays open in the live notification region. */
export const AUTO_CLOSE_MS = 5000;

export interface AppNotification {
  id: number;
  severity: Severity;
  /**
   * Where the notification came from, rendered beside the timestamp: the
   * subsystem that raised it, or the exact agent label that filed issues.
   */
  source: string;
  text: string;
  at: string;
}

const HISTORY_LIMIT = 200;

/**
 * Server errors, notices, and client connection failures. The newest entries
 * render in the live notification region and close themselves after
 * `AUTO_CLOSE_MS`; every entry stays in the history opened from the status bar.
 */
export class NotificationStore {
  /** Every notification, newest first; backs the history dialog. */
  items = $state<AppNotification[]>([]);
  /** The cards still open in the live region, newest first. */
  live = $state<AppNotification[]>([]);
  unread = $state(0);
  historyOpen = $state(false);
  private counter = 0;
  private timers = new Map<number, Timer>();

  constructor(private readonly autoCloseMs: number = AUTO_CLOSE_MS) {}

  push(source: string, severity: Severity, text: string): void {
    const message = text.trim();
    if (message.length === 0) return;
    this.counter += 1;
    const item: AppNotification = {
      id: this.counter,
      severity,
      source,
      text: message,
      at: new Date().toISOString(),
    };
    this.items = [item, ...this.items].slice(0, HISTORY_LIMIT);
    this.live = [item, ...this.live];
    this.unread += 1;
    this.timers.set(
      item.id,
      setTimeout(() => this.close(item.id), this.autoCloseMs),
    );
  }

  /** Removes a notification everywhere, including the history. */
  dismiss(id: number): void {
    this.forget(id);
    this.items = this.items.filter((item) => item.id !== id);
    this.live = this.live.filter((item) => item.id !== id);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.items = [];
    this.live = [];
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

  /** Closes one expired card; its history entry remains. */
  private close(id: number): void {
    this.forget(id);
    this.live = this.live.filter((item) => item.id !== id);
  }

  private forget(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
}

export const notifications = new NotificationStore();
