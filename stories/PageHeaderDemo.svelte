<script lang="ts">
  import Button from "../.devboard/client/lib/components/ui/button.svelte";
  import PageHeader from "../.devboard/client/lib/components/ui/page-header.svelte";

  interface Props {
    eyebrow?: string;
    title?: string;
    subtitle?: string;
    actionCount?: number;
    meta?: boolean;
    flat?: boolean;
  }

  let {
    eyebrow = "Plan",
    title = "Goal document",
    subtitle = "Saved",
    actionCount = 3,
    meta = true,
    flat = false,
  }: Props = $props();
</script>

<div style="background: var(--background); padding: 8px;">
  <PageHeader {eyebrow} {title} {subtitle} {flat}>
    {#snippet meta()}
      {#if meta}
        <span class="muted">GOAL.md is the source of truth</span>
        <span class="badge" data-tone="accent">revision ready</span>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if actionCount >= 1}
        <Button variant="outline">Show skills (5)</Button>
      {/if}
      {#if actionCount >= 2}
        <Button variant="secondary">Recreate goal</Button>
      {/if}
      {#if actionCount >= 3}
        <Button variant="default">Save goal</Button>
      {/if}
      {#if actionCount >= 4}
        <Button variant="outline">Close</Button>
      {/if}
    {/snippet}
  </PageHeader>
</div>
