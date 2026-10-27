<script lang="ts">
  interface Props {
    lines: string[];
    testid: string;
    runId?: string;
  }

  let { lines, testid, runId }: Props = $props();

  let element = $state<HTMLPreElement | null>(null);
  let follow = $state(true);

  // Tracked so the log follows its newest line unless the operator scrolled up.
  $effect(() => {
    void lines.length;
    void lines[lines.length - 1];
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

  // A shell command row is the only structure an agent stream guarantees.
  function lineKind(line: string): "blank" | "command" | "text" {
    if (line.trim().length === 0) return "blank";
    return /^\$\s/.test(line) ? "command" : "text";
  }
</script>

<pre
  class="issues-activity mono"
  data-testid={testid}
  data-run={runId}
  bind:this={element}
  onscroll={trackFollow}
>{#if lines.length === 0}<span class="issues-activity__empty">No activity yet.</span>{:else}{#each lines as line, index}{@const kind = lineKind(line)}<span class="issues-activity__line" data-kind={kind}>{#if kind === "command"}<span class="issues-activity__prompt">$</span>{line.slice(1)}{:else}{line}{/if}</span>{index === lines.length - 1 ? "" : "\n"}{/each}{/if}</pre>
