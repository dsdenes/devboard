/**
 * Where a pushed frame goes.
 *
 * A whole-resource frame is written into the query cache under the key its
 * type names, so a pushed snapshot and a fetched one are the same entry; every
 * frame is also handed to the stores that project it. A test registers its own
 * sink; the connection registers the dashboard's.
 */
import { connection } from "./connection.svelte";
import { queryClient } from "./query-client";
import { frameQueryKey } from "./query-keys";
import type { Envelope } from "./rest-transport";

type PushedFrame = Record<string, unknown> & { type: string };

/** Writes every frame into the cache and hands it to the stores. */
export function applyFrames(frames: ReadonlyArray<PushedFrame>): void {
  for (const frame of frames) {
    const key = frameQueryKey(frame);
    if (key !== null) queryClient.setQueryData(key, frame);
    connection.receiveFrame(frame);
  }
}
