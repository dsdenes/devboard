import { expect, test } from "bun:test";
import type { ConnectionStore } from "./connection.svelte";
import { DiscoverStore } from "./discover.svelte";
import { notifications } from "./notifications.svelte";

test("a Discover failure renders once, on the page, without a duplicate notification", () => {
  const discover = new DiscoverStore({} as unknown as ConnectionStore);
  notifications.clear();
  discover.handleEvent({
    type: "discoverError",
    message: "The sheet run failed: the server exit interrupted the run.",
  });
  expect(discover.displayError).toBe(
    "The sheet run failed: the server exit interrupted the run.",
  );
  expect(notifications.items).toHaveLength(0);
  expect(notifications.live).toHaveLength(0);
  notifications.clear();
});
