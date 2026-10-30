import { expect, test } from "bun:test";
import { AgentsStore } from "./agents.svelte";

test("a chat proposal is consumed once and a later proposal installs again", () => {
  const store = new AgentsStore();

  store.handleEvent({
    type: "agentPromptChatDone",
    id: "scout",
    turnId: "turn-1",
    proposal: "first proposal",
  });
  expect(store.promptProposal.scout).toEqual({ turnId: "turn-1", text: "first proposal" });

  // Applying the proposal consumes it, so a remount finds nothing to replay.
  store.consumePromptProposal("scout");
  expect(store.promptProposal.scout).toBeNull();

  store.handleEvent({
    type: "agentPromptChatDone",
    id: "scout",
    turnId: "turn-2",
    proposal: "second proposal",
  });
  expect(store.promptProposal.scout).toEqual({ turnId: "turn-2", text: "second proposal" });
  store.consumePromptProposal("scout");
  expect(store.promptProposal.scout).toBeNull();
});
