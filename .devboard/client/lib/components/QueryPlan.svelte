<script lang="ts">
  import { plannedQueries, type PlannedQuery } from "../poll-plan";
  import ResourceQuery from "./ResourceQuery.svelte";

  // The whole plan of reads the surfaces on screen show, recomputed whenever
  // the mode, the active tab, a shown run, or the connection changes. One
  // entry per resource: a surface that closes drops its entry, and a resource
  // no surface shows issues no request at all.
  let plan = $state<PlannedQuery[]>([]);
  $effect(() => {
    plan = plannedQueries();
  });
</script>

{#each plan as resource (resource.key)}
  <ResourceQuery {resource} />
{/each}
