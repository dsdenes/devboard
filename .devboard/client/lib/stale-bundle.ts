/**
 * The page's own bundle disagreeing with the server it is connected to.
 *
 * Every command one bundle sends is parsed by the server released with it, so a
 * frame the running server's protocol does not know can only come from a page
 * built against another revision. The server answers such a frame with one
 * fixed error, and the page turns the first one into a reload: the reloaded
 * page loads the bundle the server serves, so the commands agree again. The tab
 * records the attempt, because a second refusal after that reload is a frame
 * the loaded bundle itself sends, which stays a reported error.
 */

/** The exact text `run_socket` answers a frame its protocol does not know with. */
export const INVALID_FRAME_MESSAGE = "Invalid WebSocket message.";

/** The tab-session key recording the one reload a tab spends on a stale bundle. */
export const STALE_BUNDLE_RELOAD_KEY = "devboard.staleBundleReload";

/** Whether one server frame is its refusal of a command this page sent. */
export function isInvalidFrameError(frame: { type?: unknown; message?: unknown }): boolean {
  return frame.type === "error" && frame.message === INVALID_FRAME_MESSAGE;
}

/**
 * Reloads the page once per tab session so the stale bundle is replaced by the
 * one the server serves, and answers whether this refusal spent that reload. A
 * storage that is absent or refuses the write — a private-mode browser — leaves
 * the refusal reported instead of risking a reload loop.
 */
export function reloadOnceForStaleBundle(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  reload: () => void,
): boolean {
  if (storage === null) return false;
  try {
    if (storage.getItem(STALE_BUNDLE_RELOAD_KEY) !== null) return false;
    storage.setItem(STALE_BUNDLE_RELOAD_KEY, "1");
  } catch {
    return false;
  }
  reload();
  return true;
}
