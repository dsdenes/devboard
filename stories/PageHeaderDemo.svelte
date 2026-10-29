<script lang="ts">
  import Button from "../.devboard/client/lib/components/ui/button.svelte";
  import Input from "../.devboard/client/lib/components/ui/input.svelte";
  import PageHeader from "../.devboard/client/lib/components/ui/page-header.svelte";

  interface Props {
    eyebrow?: string;
    title?: string;
    subtitle?: string;
    actionCount?: number;
    meta?: boolean;
    footer?: boolean;
    flat?: boolean;
    layout?: "stacked" | "bar";
  }

  let {
    eyebrow = "Plan",
    title = "Goal document",
    subtitle = "Saved",
    actionCount = 3,
    meta = true,
    footer = false,
    flat = false,
    layout = "stacked",
  }: Props = $props();
</script>

<div style="background: var(--background); padding: 8px;">
  <PageHeader {eyebrow} {title} {subtitle} {flat} {layout}>
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
    {#if footer}
      {#snippet footer()}
        <div
          style="align-items: center; display: flex; flex-wrap: wrap; font-size: 11px; gap: 6px 24px;"
        >
          <div style="align-items: center; display: flex; gap: 10px;">
            <span class="muted">Cadence</span>
            <label class="muted" style="align-items: center; display: flex; gap: 4px;">
              Every
              <Input type="number" class="w-16 text-center" value="30" />
              min
            </label>
            <span class="muted">Last run never</span>
            <Button variant="secondary">Save cadence</Button>
          </div>
          <div style="align-items: center; display: flex; gap: 10px;">
            <span class="muted">Filing limits</span>
            <label class="muted" style="align-items: center; display: flex; gap: 4px;">
              Per hour
              <Input type="number" class="w-16 text-center" placeholder="unlimited" />
            </label>
            <Button variant="secondary">Save limits</Button>
          </div>
        </div>
      {/snippet}
    {/if}
  </PageHeader>
</div>
