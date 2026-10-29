<script lang="ts">
  import IssuesAgentLog from "./IssuesAgentLog.svelte";

  interface Props {
    /** The descriptor id; its activity panel is `<id>-activity`. */
    agentId: string;
    lines: string[];
    scanId: string | null;
  }

  let { agentId, lines, scanId }: Props = $props();
</script>

<section class="panel issues-activity-panel">
  <div class="panel__header">
    <h2 class="panel__title">Scan activity</h2>
    <span class="panel__subtitle" title={scanId ?? "No scan yet"}>{scanId ?? "No scan yet"}</span>
  </div>
  <IssuesAgentLog lines={lines} testid={`${agentId}-activity`} />
</section>
