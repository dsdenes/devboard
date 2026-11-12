<script lang="ts">
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import FeedbackOverlay from "../../FeedbackOverlay.svelte";
  import { queryClient } from "../query-client";
  import type { FeedbackAction, FeedbackPhase } from "../types";

  // The feedback overlay's own root: one client, so its Ask conversation is a
  // query like every other read.
  let {
    phase = $bindable<FeedbackPhase>("idle"),
    action = $bindable<FeedbackAction | null>(null),
  }: { phase?: FeedbackPhase; action?: FeedbackAction | null } = $props();

  let overlay = $state<{
    startPicking: () => void;
    startRemoving: () => void;
    startRedesigning: () => void;
    toggleReport: () => void;
    toggleAction: (action: FeedbackAction) => void;
    cancelReport: () => void;
  }>();

  export function startPicking(): void {
    overlay?.startPicking();
  }
  export function startRemoving(): void {
    overlay?.startRemoving();
  }
  export function startRedesigning(): void {
    overlay?.startRedesigning();
  }
  export function toggleReport(): void {
    overlay?.toggleReport();
  }
  export function toggleAction(action: FeedbackAction): void {
    overlay?.toggleAction(action);
  }
  export function cancelReport(): void {
    overlay?.cancelReport();
  }
</script>

<QueryClientProvider client={queryClient}>
  <FeedbackOverlay bind:this={overlay} bind:phase bind:action />
</QueryClientProvider>
