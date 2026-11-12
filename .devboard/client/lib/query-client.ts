/**
 * The one query cache this page uses.
 *
 * Every backend read is a query in this cache, every command's answer is
 * written here, and every pushed frame lands in the same entries. Cadence is
 * the queries' own: a query is mounted only while a surface shows it, and its
 * interval is the finest cadence that surface earns.
 */
import { QueryClient, focusManager } from "@tanstack/svelte-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A mounted query is the surface's own read; a remount within the same
      // cadence does not fetch the same resource again.
      staleTime: 1_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * A hidden document issues nothing. TanStack pauses every interval while the
 * page is unfocused; pausing exactly when the document is hidden preserves
 * that contract without a scheduler timer of the page's own.
 */
export function installVisibilityCadence(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  const notify = () => {
    focusManager.setFocused(document.visibilityState !== "hidden");
    if (document.visibilityState !== "hidden") {
      void queryClient.invalidateQueries();
    }
  };
  document.addEventListener("visibilitychange", notify);
  notify();
  return () => {
    document.removeEventListener("visibilitychange", notify);
    focusManager.setFocused(undefined);
  };
}
