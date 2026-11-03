import type { ProviderKeyStatus, ProviderSelection } from "./types";

/**
 * The Providers dialog and the status-bar control render the same masked
 * provider view the store mirrors. Every string they show is composed here, so
 * a copy change never touches the socket transport.
 */

/** Formats a remaining fraction as a compact percentage. */
export function percentText(fraction: number | null): string {
  if (fraction === null) return "unknown";
  const percent = Math.max(0, Math.min(100, fraction * 100));
  if (percent === 100) return "100%";
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/** The status text one subscription row shows. */
export function statusText(status: ProviderKeyStatus): string {
  switch (status) {
    case "ok":
      return "ok";
    case "near-limit":
      return "near limit";
    case "exhausted":
      return "exhausted";
    case "invalid":
      return "invalid";
    default:
      return "unknown";
  }
}

/** The status bar's provider label: the selected provider and its remainder. */
export function providerIndicatorLabel(selection: ProviderSelection | null): string {
  if (selection === null) return "No provider";
  return `${selection.providerName} · ${percentText(selection.remainingFraction)}`;
}

export interface ProviderIndicatorInput {
  selection: ProviderSelection | null;
  /** The server's refusal to serve peers, when it has one. */
  refusal: string | null;
  /** The rotation rule the server enforces, stated in the tooltip. */
  rule: string;
}

/** The provider indicator's tooltip: what serves peers, and under which rule. */
export function providerIndicatorTitle(input: ProviderIndicatorInput): string {
  const selection = input.selection;
  if (selection === null) {
    return input.refusal ?? "No provider subscription is configured. Open the Providers dialog.";
  }
  return `${selection.providerName} (${selection.label}) serves peers on ${selection.model}; ${percentText(
    selection.remainingFraction,
  )} remaining. ${input.rule}.`;
}
