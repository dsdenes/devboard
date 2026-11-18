<script lang="ts">
  import type { ComponentProps, Snippet } from "svelte";
  import CommandButton from "./CommandButton.svelte";
  import { connection } from "../connection.svelte";

  interface Props
    extends Omit<
      ComponentProps<typeof CommandButton>,
      "label" | "evidence" | "command" | "children"
    > {
    /** The resting label the busy word and the ceiling notice derive from. */
    label?: string;
    /** The control's visible content; it replaces the resting label. */
    children: Snippet;
  }

  let { label = "Reload", children, ...rest }: Props = $props();
</script>

<!-- The replacement retry is answered either by a fresh version frame or by the
     request's own answer: `versionRevision` covers a retry the server reports
     as failed, and `restartAnswerRevision` covers the two refusals and a
     failed fetch, which never produce a version frame. Both the status bar and
     the unsupported-viewport page render this one control, so neither can
     latch on the wrong evidence, and a request no answer reaches still shows
     the ceiling notice. -->
<CommandButton
  {label}
  evidence={() => connection.versionRevision}
  refusal={() => connection.restartAnswerRevision}
  command={() => connection.requestRestart()}
  {...rest}
>
  {@render children()}
</CommandButton>
