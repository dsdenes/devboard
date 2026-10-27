<script lang="ts">
  import { layout } from "../layout.svelte";

  interface Props {
    /** A Mermaid `flowchart` source built from the published context edges. */
    code: string;
    label: string;
  }

  let { code, label }: Props = $props();

  let svg = $state("");
  let failed = $state(false);
  let sequence = 0;

  const palette = {
    dark: {
      primaryColor: "#16233a",
      primaryTextColor: "#e6edf3",
      primaryBorderColor: "#58a6ff",
      lineColor: "#58a6ff",
      secondaryColor: "#21262d",
      tertiaryColor: "#161b22",
      background: "#0d1117",
      mainBkg: "#16233a",
      nodeBorder: "#58a6ff",
      clusterBkg: "#161b22",
      titleColor: "#e6edf3",
    },
    light: {
      primaryColor: "#eef4ff",
      primaryTextColor: "#1f2328",
      primaryBorderColor: "#0969da",
      lineColor: "#0969da",
      secondaryColor: "#f6f8fa",
      tertiaryColor: "#ffffff",
      background: "#ffffff",
      mainBkg: "#eef4ff",
      nodeBorder: "#0969da",
      clusterBkg: "#f6f8fa",
      titleColor: "#1f2328",
    },
  } as const;

  async function draw(): Promise<void> {
    const source = code.trim();
    if (source.length === 0) {
      svg = "";
      failed = false;
      return;
    }
    try {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({
        startOnLoad: false,
        // Strict mode escapes labels and refuses click handlers and raw HTML.
        securityLevel: "strict",
        theme: "base",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        fontSize: 12,
        themeVariables: palette[layout.theme],
        flowchart: { curve: "basis", htmlLabels: false, padding: 8 },
      });
      sequence += 1;
      const id = `devboard-context-map-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
      const rendered = await mermaid.render(id, source);
      svg = rendered.svg;
      failed = false;
    } catch {
      svg = "";
      failed = true;
    }
  }

  $effect(() => {
    void code;
    void layout.theme;
    void draw();
  });
</script>

<div class="mermaid-diagram" role="img" aria-label={label} data-testid="mermaid-diagram">
  {#if failed}
    <p class="empty">The context map could not be drawn; the direction statement below still applies.</p>
  {:else if svg.length === 0}
    <p class="empty">Drawing the context map…</p>
  {:else}
    {@html svg}
  {/if}
</div>
