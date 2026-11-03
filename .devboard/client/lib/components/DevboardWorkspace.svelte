<script lang="ts">
  import { onMount } from "svelte";
  import { agentRegistry } from "../../../lib/agent-registry.ts";
  import { connection } from "../connection.svelte";
  import { devboard } from "../devboard.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import AgentPage from "./AgentPage.svelte";
  import DevboardComplexity from "./DevboardComplexity.svelte";
  import DevboardSkills from "./DevboardSkills.svelte";
  import PageHeader from "./ui/page-header.svelte";

  interface Props {
    tab: WorkspaceTab | null;
  }

  let { tab }: Props = $props();

  const agentDescriptor = $derived(tab === null ? undefined : agentRegistry.get(tab.kind));
  const count = $derived(devboard.tools.length);

  // Counts change while a peer runs, so the page re-reads them on the same
  // cadence as the version poll instead of waiting for a reload.
  onMount(() => {
    const timer = setInterval(() => {
      if (connection.open) devboard.request();
    }, 5000);
    return () => clearInterval(timer);
  });
</script>

{#if agentDescriptor !== undefined}
  <AgentPage agentId={agentDescriptor.id} />
{:else if tab?.kind === "devboard-skills"}
  <DevboardSkills />
{:else if tab?.kind === "devboard-complexity"}
  <DevboardComplexity />
{:else}
  <div class="mode-body" data-testid="devboard-workspace">
    <PageHeader
      title={tab?.title ?? "MCP tools"}
      layout="bar"
      testid="devboard-header"
    >
      {#snippet meta()}
        <span class="devboard-count">
          {count}
          {count === 1 ? "tool" : "tools"}
        </span>
      {/snippet}
    </PageHeader>

    <section class="panel devboard-panel" aria-label="MCP tools">
      <div class="devboard-list" data-testid="mcp-tools-list">
        {#each devboard.tools as tool (tool.name)}
          <article class="devboard-tool" data-testid="mcp-tool" data-tool={tool.name}>
            <div class="devboard-tool__head">
              <code class="devboard-tool__name">{tool.name}</code>
              <span class="devboard-tool__title">{tool.title}</span>
              <span
                class="devboard-tool__invocations"
                data-testid="mcp-tool-invocations"
                data-invocations={tool.invocations}
              >
                {tool.invocations} {tool.invocations === 1 ? "invocation" : "invocations"}
              </span>
            </div>
            <p class="devboard-tool__description">{tool.description}</p>
          </article>
        {:else}
          <p class="empty" data-testid="mcp-tools-empty">
            {devboard.loaded ? "No MCP tools are exposed." : "Loading the MCP tool catalog…"}
          </p>
        {/each}
      </div>
    </section>
  </div>
{/if}

<style>
  .devboard-count {
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .devboard-panel {
    flex: 1;
    min-height: 0;
  }

  .devboard-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0;
  }

  .devboard-tool {
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 12px;
  }

  .devboard-tool:last-child {
    border-bottom: 0;
  }

  .devboard-tool__head {
    align-items: baseline;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .devboard-tool__name {
    color: var(--foreground);
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
  }

  .devboard-tool__title {
    color: var(--foreground);
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .devboard-tool__description {
    color: var(--muted-foreground);
    font-size: 12px;
    line-height: 1.45;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .devboard-tool__invocations {
    color: var(--muted-foreground);
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: 11px;
    margin-left: auto;
  }
</style>
