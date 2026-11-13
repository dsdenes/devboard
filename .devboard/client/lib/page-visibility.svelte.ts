/**
 * The document's own visibility, as one reactive value.
 *
 * A hidden document issues nothing. The query cadence already pauses every
 * interval while the page is hidden (`installVisibilityCadence`), and this is
 * the same contract for the reads a surface dispatches itself: a page the
 * operator cannot see sends no page-open read. A browser also throttles a
 * hidden document's timers and defers its rendering, so work issued there is
 * measured against the browser's scheduling instead of the server's answer.
 */
let visible = $state(true);

export const pageVisibility = {
  /** True while the document is visible. */
  get visible(): boolean {
    return visible;
  },

  /**
   * Follows the document's visibility for the lifetime of the page. Returns
   * the cleanup the caller runs when the page unmounts.
   */
  install(): () => void {
    if (typeof document === "undefined") return () => {};
    const notify = () => {
      visible = document.visibilityState !== "hidden";
    };
    document.addEventListener("visibilitychange", notify);
    notify();
    return () => {
      document.removeEventListener("visibilitychange", notify);
    };
  },
};
