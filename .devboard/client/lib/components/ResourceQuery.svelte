<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { applyFrames } from "../frames";
  import type { PlannedQuery } from "../poll-plan";
  import { queryKeyFor } from "../query-keys";
  import { readResource } from "../rest-transport";

  interface Props {
    resource: PlannedQuery;
  }

  let { resource }: Props = $props();

  /**
   * One mounted resource is one query. The plan states the key, the enabled
   * flag, and the cadence; two surfaces showing the resource share this one
   * observer, and two mounts of the same key share one in-flight request.
   */
  const query = createQuery(() => {
    const key = queryKeyFor(resource.command);
    return {
      queryKey: key ?? ["unplanned", resource.command.type],
      queryFn: async () => {
        const frames = await readResource(resource.command);
        applyFrames(frames);
        return frames;
      },
      enabled: key !== null && resource.enabled,
      refetchInterval: resource.interval > 0 ? resource.interval : false,
      refetchIntervalInBackground: false,
      staleTime: resource.interval > 0 ? resource.interval : Infinity,
    };
  });
  void query;
</script>
