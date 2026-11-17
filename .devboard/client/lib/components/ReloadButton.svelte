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

<!-- The replacement retry is answered by a fresh version frame, so it latches
     on the frame's revision rather than on `running`: a retry the server
     reports as failed keeps the old process serving, which leaves `running`
     unchanged, and only the frame's arrival distinguishes an answer from
     silence. Both the status bar and the unsupported-viewport page render this
     one control, so neither can latch on the wrong evidence. -->
<CommandButton
  {label}
  evidence={() => connection.versionRevision}
  command={() => connection.requestRestart()}
  {...rest}
>
  {@render children()}
</CommandButton>
