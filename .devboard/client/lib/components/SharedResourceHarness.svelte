<script lang="ts">
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import { queryClient } from "../query-client";
  import type { PlannedQuery } from "../poll-plan";
  import ResourceQuery from "./ResourceQuery.svelte";

  // Two surfaces showing one resource: both mount the same key, which must
  // cost one request.
  const resource: PlannedQuery = {
    key: "getIssues:/issues",
    command: { type: "getIssues" },
    interval: 10_000,
    enabled: true,
    once: false,
  };
</script>

<QueryClientProvider client={queryClient}>
  <ResourceQuery {resource} />
  <ResourceQuery {resource} />
</QueryClientProvider>
