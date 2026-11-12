<script lang="ts">
  import { createMutation } from "@tanstack/svelte-query";
  import { connection } from "../connection.svelte";
  import { registerMutations, type CommandMutation } from "../command-mutations";
  import { applyFrames } from "../frames";
  import { notifications } from "../notifications.svelte";
  import { queryClient } from "../query-client";
  import { invalidatedResources } from "../query-keys";
  import { REST_OPERATIONS } from "../rest-map";
  import {
    sendCommand,
    TransportError,
    type Command,
    type Envelope,
  } from "../rest-transport";

  // Every command the client knows is one mutation created here, at the app
  // root. A store's control hands `connection.send` the command object and the
  // mutation posts it; the answer lands in the query cache, then exactly the
  // resources that answer changed are invalidated.
  const mutations: Record<string, CommandMutation> = {};
  for (const type of Object.keys(REST_OPERATIONS)) {
    const operation = REST_OPERATIONS[type];
    if (operation === undefined || operation.method === "GET") continue;
    const mutation = createMutation(() => ({
      mutationFn: (command: Command) => sendCommand(command),
      onSuccess: (frames: Envelope[]) => {
        applyFrames(frames);
        for (const resource of invalidatedResources(type)) {
          void queryClient.invalidateQueries({ queryKey: [resource] });
        }
      },
      onError: (error: Error) => {
        if (error instanceof TransportError && error.status === null) {
          connection.noticeTransportFailure();
          return;
        }
        notifications.push("Server", "error", error.message);
      },
    }));
    mutations[type] = {
      mutate: (command: Command, onSettled?: () => void) => mutation.mutate(command, { onSettled }),
    };
  }
  registerMutations(mutations);
</script>
