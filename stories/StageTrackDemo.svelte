<script lang="ts">
  import StageTrack from "../.devboard/client/lib/components/ui/stage-track.svelte";
  import type { LifecycleStage } from "../.devboard/client/lib/types";

  interface Props {
    stage?: LifecycleStage;
    pass?: number;
    paused?: boolean;
    seen?: boolean;
    workLabel?: string | null;
    workUrl?: string | null;
    manual?: boolean;
    narrow?: boolean;
  }

  let {
    stage = "adr",
    pass = 2,
    paused = false,
    seen = true,
    workLabel = "0003-ledger-schema.md",
    workUrl = null,
    manual = false,
    narrow = false,
  }: Props = $props();
</script>

<div
  style={`background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 8px; ${narrow ? "max-width: 360px;" : ""}`}
>
  <StageTrack {stage} {pass} {paused} {seen} {workLabel} {workUrl} {manual} />
</div>
