<script lang="ts">
  import X from "lucide-svelte/icons/x";
  import Button from "./ui/button.svelte";

  interface Props {
    /** The ceiling text naming the action that received no answer. */
    text: string;
    ondismiss: () => void;
    "data-testid"?: string;
  }

  let { text, ondismiss, "data-testid": testid = "command-notice" }: Props = $props();
</script>

<!-- The 10-second ceiling notice: beside its control, never replacing a message. -->
<p class="command-notice" role="status" data-testid={testid}>
  <span class="command-notice__text">{text}</span>
  <Button
    bare
    class="command-notice__dismiss"
    aria-label="Dismiss the notice"
    title="Dismiss"
    onclick={ondismiss}
  >
    <X size={12} aria-hidden="true" />
  </Button>
</p>
