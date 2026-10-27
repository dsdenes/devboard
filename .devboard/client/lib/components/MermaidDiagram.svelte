<script lang="ts">
  interface Props {
    chart: string;
    label: string;
  }

  let { chart, label }: Props = $props();

  let host = $state<HTMLDivElement>();
  let failed = $state(false);
  let sequence = 0;

  function palette(): Record<string, string> {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string => {
      const value = styles.getPropertyValue(name).trim();
      return value.length > 0 ? value : fallback;
    };
    return {
      background: read("--surface", "#161b22"),
      surfaceRaised: read("--surface-raised", "#1c2128"),
      foreground: read("--foreground", "#e6edf3"),
      border: read("--border", "#30363d"),
      borderStrong: read("--border-strong", "#6e7681"),
      fontFamily: read("--font-sans", "ui-sans-serif, system-ui, sans-serif"),
    };
  }

  async function draw(source: string): Promise<void> {
    const target = host;
    if (target === undefined || source.trim().length === 0) return;
    const current = ++sequence;
    try {
      const { default: mermaid } = await import("mermaid");
      const colors = palette();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: colors.fontFamily,
        themeVariables: {
          background: colors.background,
          primaryColor: colors.surfaceRaised,
          primaryTextColor: colors.foreground,
          primaryBorderColor: colors.borderStrong,
          secondaryColor: colors.background,
          tertiaryColor: colors.background,
          lineColor: colors.borderStrong,
          textColor: colors.foreground,
          edgeLabelBackground: colors.background,
          nodeBorder: colors.borderStrong,
          clusterBkg: colors.background,
          clusterBorder: colors.border,
          fontSize: "13px",
        },
        flowchart: { curve: "basis", htmlLabels: false, padding: 12 },
      });
      const { svg } = await mermaid.render(`discover-dependency-${Date.now()}-${current}`, source);
      if (current !== sequence) return;
      target.innerHTML = svg;
      failed = false;
    } catch {
      if (current !== sequence) return;
      target.innerHTML = "";
      failed = true;
    }
  }

  $effect(() => {
    void draw(chart);
    const observer = new MutationObserver(() => void draw(chart));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  });
</script>

<div
  class="discover-diagram"
  data-testid="discover-dependency-diagram"
  role="img"
  aria-label={label}
  bind:this={host}
></div>
{#if failed}
  <p class="empty">The dependency diagram could not be rendered.</p>
{/if}
