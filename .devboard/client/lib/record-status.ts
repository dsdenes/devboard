/** Badge tones `app.css` styles for `.badge[data-tone]`. */
export type BadgeTone = "pending" | "success" | "warning" | "error" | "accent" | "stale";

/**
 * The tone one decision record's status earns. A record's `status` is the raw
 * markdown line (`- Status: Accepted`), so the mapping is on the normalized
 * word; an unrecognized status keeps the neutral badge rather than guessing.
 */
export function recordStatusTone(status: string): BadgeTone | undefined {
  switch (status.trim().toLowerCase()) {
    case "accepted":
      return "success";
    case "proposed":
      return "pending";
    case "superseded":
    case "deprecated":
      return "stale";
    case "rejected":
      return "error";
    default:
      return undefined;
  }
}
