import type { AppNotification, Severity } from "./notifications.svelte";

/** The server's `report` bound; the title line and metadata must fit inside it. */
export const MAX_NOTIFICATION_REPORT = 8000;

const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  notice: "Notice",
  success: "Success",
};

/**
 * The report a notification button files. Its first line becomes the issue
 * title, so the notification text leads, labelled with its severity; the
 * source and timestamp follow as context. The whole report stays inside the
 * server's bound even for a long server message.
 */
export function notificationReport(item: AppNotification): string {
  const prefix = `${SEVERITY_LABEL[item.severity]} notification: `;
  const suffix = `\n\nSource: ${item.source}\nRaised at: ${item.at}`;
  const budget = Math.max(0, MAX_NOTIFICATION_REPORT - prefix.length - suffix.length);
  const text = item.text.trim();
  const body =
    text.length <= budget ? text : `${text.slice(0, Math.max(0, budget - 1)).trimEnd()}…`;
  return `${prefix}${body}${suffix}`;
}
