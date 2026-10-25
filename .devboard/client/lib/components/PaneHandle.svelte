<script lang="ts">
  import { PaneResizer } from "paneforge";

  interface Props {
    orientation: "horizontal" | "vertical";
    minimum: number;
    maximum: number;
    current: number;
    label: string;
    ondblclick?: () => void;
  }

  let { orientation, minimum, maximum, current, label, ondblclick }: Props = $props();
</script>

<PaneResizer
  class="pane-handle"
  data-testid="pane-handle"
  aria-orientation={orientation}
  aria-valuemin={Math.round(minimum)}
  aria-valuemax={Math.round(maximum)}
  aria-valuenow={Math.round(current)}
  aria-label={label}
  {ondblclick}
/>
