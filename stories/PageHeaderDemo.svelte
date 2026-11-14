<script lang="ts">
  import AgentSettings from "../.devboard/client/lib/components/AgentSettings.svelte";
  import Button from "../.devboard/client/lib/components/ui/button.svelte";
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

  // The named snippets below become the header's `meta` and `footer` props, so
  // the boolean props they gate are bound under their own names: reading
  // `footer` here would resolve to the snippet and render it unconditionally.
  let {
    eyebrow = "Plan",
    title = "Goal document",
    subtitle = "Saved",
    actionCount = 3,
    meta: showMeta = true,
    footer: showFooter = false,
    flat = false,
    layout = "stacked",
  }: Props = $props();
</script>

{#snippet footerBand()}
  <AgentSettings
    cadenceText="10"
    lastRunAt="2026-11-14T09:55:00.000Z"
    nextRunAt="2026-11-14T10:05:00.000Z"
  />
{/snippet}

<div style="background: var(--background); padding: 8px;">
  <PageHeader
    {eyebrow}
    {title}
    {subtitle}
    {flat}
    {layout}
    footer={showFooter ? footerBand : undefined}
  >
    {#snippet meta()}
      {#if showMeta}
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
