<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { Pane, PaneGroup } from "paneforge";
  import { layout } from "../layout.svelte";
  import PaneHandle from "./PaneHandle.svelte";

  interface Props {
    id: string;
    label: string;
    defaultSplit?: number;
    main: Snippet;
    detail: Snippet;
  }

  let { id, label, defaultSplit = 62, main, detail }: Props = $props();

  let group: { setLayout: (sizes: number[]) => void } | undefined = $state();
  let container: HTMLDivElement | undefined = $state();
  let sizes = $state<number[]>([]);
  let groupWidth = $state(0);

  const available = $derived(groupWidth > 0 ? groupWidth : 960);
  const minimumPercent = $derived((160 / available) * 100);
  const mainPercent = $derived(sizes[0] ?? defaultSplit);

  function reset(): void {
    group?.setLayout([defaultSplit, 100 - defaultSplit]);
  }

  onMount(() => {
    if (container === undefined) return;
    const observer = new ResizeObserver(() => {
      groupWidth = container?.getBoundingClientRect().width ?? 0;
    });
    observer.observe(container);
    groupWidth = container.getBoundingClientRect().width;
    return () => observer.disconnect();
  });
</script>

<div class="split-fill" bind:this={container}>
<PaneGroup
  direction="horizontal"
  autoSaveId={`devboard.detail.${id}.${layout.epoch}`}
  bind:this={group}
  onLayoutChange={(next) => {
    if (next.length === 2) sizes = next;
  }}
  class="split-fill"
>
  <Pane minSize={minimumPercent} class="pane-fill">
    {@render main()}
  </Pane>
  <PaneHandle
    orientation="vertical"
    minimum={160}
    maximum={available - 160}
    current={(mainPercent / 100) * available}
    label={`${label} split`}
    ondblclick={reset}
  />
  <Pane minSize={minimumPercent} class="pane-fill">
    {@render detail()}
  </Pane>
</PaneGroup>
</div>
