<script lang="ts">
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import CommandMutations from "./CommandMutations.svelte";
  import QueryPlan from "./QueryPlan.svelte";
  import { queryClient } from "../query-client";

  // The test runtime's own root: one client, the plan the surfaces claim, and
  // every command mutation. The app root renders the same three pieces.
</script>

<QueryClientProvider client={queryClient}>
  <QueryPlan />
  <CommandMutations />
</QueryClientProvider>
