<script lang="ts">
  import FeedbackOverlay from "../../client/FeedbackOverlay.svelte";
  import type { FeedbackAction, FeedbackPhase } from "../../client/lib/types";

  /**
   * Mirrors the shell's binding: the overlay owns `phase` and `action`, and the
   * test reads the values the shell would render from `state`.
   */
  let {
    snapshot,
  }: {
    snapshot: { phase: FeedbackPhase; action: FeedbackAction | null };
  } = $props();

  let phase = $state<FeedbackPhase>("idle");
  let action = $state<FeedbackAction | null>(null);
  let overlay = $state<{ startPicking(): void } | null>(null);

  $effect(() => {
    snapshot.phase = phase;
    snapshot.action = action;
  });

  export function startPicking(): void {
    overlay?.startPicking();
  }
</script>

<FeedbackOverlay bind:this={overlay} bind:phase bind:action />
