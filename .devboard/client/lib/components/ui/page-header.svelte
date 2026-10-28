<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    eyebrow?: string;
    title: string;
    subtitle?: string;
    /** Optional meta line under the subtitle; status words and counts live here. */
    meta?: Snippet;
    /** Page-level actions. At most one filled primary action. */
    actions?: Snippet;
    /** Renders without the panel frame so a parent panel can own the border. */
    flat?: boolean;
    /**
     * `stacked` keeps the identity, meta, and actions on their own lines. `bar`
     * puts the title, subtitle, meta, and actions on one row for operational
     * pages whose status belongs beside the action it qualifies.
     */
    layout?: "stacked" | "bar";
    testid?: string;
  }

  let {
    eyebrow,
    title,
    subtitle,
    meta,
    actions,
    flat = false,
    layout = "stacked",
    testid,
  }: Props = $props();
</script>

<header
  class="page-header"
  class:page-header--flat={flat}
  class:page-header--bar={layout === "bar"}
  data-testid={testid}
>
  <div class="page-header__identity">
    {#if eyebrow}
      <p class="page-header__eyebrow">{eyebrow}</p>
    {/if}
    <div class="page-header__headline">
      <h1 class="page-header__title" title={title}>{title}</h1>
      {#if subtitle}
        <p class="page-header__subtitle">{subtitle}</p>
      {/if}
    </div>
    {#if meta && layout === "stacked"}
      <div class="page-header__meta">{@render meta()}</div>
    {/if}
  </div>
  {#if layout === "bar"}
    {#if meta || actions}
      <div class="page-header__tail">
        {#if meta}
          <div class="page-header__meta">{@render meta()}</div>
        {/if}
        {#if actions}
          <div class="page-header__actions">{@render actions()}</div>
        {/if}
      </div>
    {/if}
  {:else if actions}
    <div class="page-header__actions">{@render actions()}</div>
  {/if}
</header>

<style>
  .page-header {
    align-items: flex-start;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    display: flex;
    flex: 0 0 auto;
    gap: 12px;
    justify-content: space-between;
    min-width: 0;
    padding: 10px 12px;
  }

  .page-header--flat {
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0;
  }

  .page-header__identity {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .page-header__headline {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .page-header__eyebrow {
    color: var(--muted-foreground);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    margin: 0;
    text-transform: uppercase;
  }

  .page-header__title {
    color: var(--foreground);
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.01em;
    line-height: 1.2;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .page-header__subtitle {
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .page-header__meta {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 4px;
  }

  .page-header__actions {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }

  /* The bar layout is one dense row: the title and repository on the left, then
     the state cluster and its action on the right. */
  .page-header--bar {
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 16px;
    padding: 8px 12px;
  }

  .page-header--bar .page-header__identity {
    min-width: 200px;
  }

  .page-header--bar .page-header__headline {
    align-items: baseline;
    flex-direction: row;
    gap: 8px;
  }

  .page-header--bar .page-header__subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .page-header__tail {
    align-items: center;
    display: flex;
    flex: 0 1 auto;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: flex-end;
    margin-left: auto;
    min-width: 0;
  }

  .page-header--bar .page-header__meta {
    flex-wrap: nowrap;
    margin-top: 0;
  }

  .page-header--bar .page-header__actions {
    flex: 0 1 auto;
    min-width: 0;
  }
</style>
