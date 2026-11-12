/**
 * The one label that marks an open issue's run in progress. The forge read is
 * the only source of a row's state, so the worker writes this label around a
 * run and every surface reads it; no ledger entry or run marker substitutes.
 */
export const PROCESSING_LABEL = "processing";

/** True when a forge-listed issue carries the processing label. */
export function hasProcessingLabel(labels: readonly string[] | undefined): boolean {
  return labels?.includes(PROCESSING_LABEL) === true;
}
