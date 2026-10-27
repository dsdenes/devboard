<script lang="ts">
  interface Props {
    lines: string[];
    testid: string;
    runId: string;
  }

  let { lines, testid, runId }: Props = $props();

  let element = $state<HTMLPreElement | null>(null);
  let follow = $state(true);
  const text = $derived(lines.length === 0 ? "No activity yet." : lines.join("\n"));

  // Tracked so the log follows its newest line unless the operator scrolled up.
  $effect(() => {
    void text;
    if (!follow || element === null) return;
    element.scrollTop = element.scrollHeight;
  });

  $effect(() => {
    const current = element;
    if (current === null) return;
    const observer = new ResizeObserver(() => {
      if (!follow) return;
      current.scrollTop = current.scrollHeight;
    });
    observer.observe(current);
    return () => observer.disconnect();
  });

  function trackFollow(event: Event & { currentTarget: HTMLPreElement }): void {
    const current = event.currentTarget;
    follow = current.scrollHeight - current.scrollTop - current.clientHeight <= 8;
  }
</script>

<pre
  class="issues-activity mono"
  data-testid={testid}
  data-run={runId}
  bind:this={element}
  onscroll={trackFollow}
>{text}</pre>
