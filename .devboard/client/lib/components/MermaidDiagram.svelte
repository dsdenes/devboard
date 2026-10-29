<script lang="ts">
  import { DIAGRAM_MIN_READABLE_SCALE, diagramMode, type DiagramMode } from "../dependency-diagram";
  import Button from "./ui/button.svelte";

  interface Props {
    chart: string;
    label: string;
  }

  let { chart, label }: Props = $props();

  let host = $state<HTMLDivElement>();
  let canvas = $state<HTMLDivElement>();
  let failed = $state(false);
  let rendered = $state<SVGSVGElement | null>(null);
  let naturalWidth = $state(0);
  let availableWidth = $state(0);
  let chosen = $state<DiagramMode | null>(null);
  let sequence = 0;

  const mode = $derived(diagramMode(naturalWidth, availableWidth, chosen));
  const zoomable = $derived(
    naturalWidth > 0 &&
      availableWidth > 0 &&
      availableWidth / naturalWidth < DIAGRAM_MIN_READABLE_SCALE,
  );

  function palette(): Record<string, string> {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string => {
      const value = styles.getPropertyValue(name).trim();
      return value.length > 0 ? value : fallback;
    };
    return {
      background: read("--background", "#0d1117"),
      surfaceRaised: read("--surface-raised", "#1c2128"),
      foreground: read("--foreground", "#e6edf3"),
      mutedForeground: read("--muted-foreground", "#8b949e"),
      border: read("--border", "#30363d"),
      borderStrong: read("--border-strong", "#6e7681"),
      fontFamily: read("--font-sans", "ui-sans-serif, system-ui, sans-serif"),
    };
  }

  function syncTabStop(): void {
    const viewport = canvas;
    if (viewport === undefined) return;
    const scrolls =
      viewport.scrollWidth > viewport.clientWidth + 1 ||
      viewport.scrollHeight > viewport.clientHeight + 1;
    viewport.tabIndex = scrolls ? 0 : -1;
  }

  function measure(): void {
    const viewport = canvas;
    if (viewport === undefined) return;
    const styles = getComputedStyle(viewport);
    const horizontal = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
    availableWidth = Math.max(0, viewport.clientWidth - horizontal);
    syncTabStop();
  }

  function declaredWidth(element: SVGSVGElement): number {
    const declared = Number.parseFloat(element.style.maxWidth);
    return Number.isFinite(declared) && declared > 0 ? declared : element.viewBox.baseVal.width;
  }

  function applySize(element: SVGSVGElement, mode: DiagramMode, width: number): void {
    if (width <= 0) return;
    if (mode === "actual") {
      element.style.width = `${width}px`;
      element.style.maxWidth = "none";
    } else {
      element.style.width = "100%";
      element.style.maxWidth = `${width}px`;
    }
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
          lineColor: colors.mutedForeground,
          textColor: colors.foreground,
          edgeLabelBackground: colors.background,
          nodeBorder: colors.borderStrong,
          clusterBkg: colors.background,
          clusterBorder: colors.border,
          fontSize: "12px",
        },
        flowchart: {
          htmlLabels: true,
          curve: "basis",
          padding: 8,
          nodeSpacing: 16,
          rankSpacing: 28,
        },
      });
      const { svg } = await mermaid.render(`discover-dependency-${Date.now()}-${current}`, source);
      if (current !== sequence) return;
      target.innerHTML = svg;
      const element = target.querySelector("svg");
      rendered = element;
      failed = false;
      measure();
      naturalWidth = element === null ? 0 : declaredWidth(element);
      if (element !== null) {
        applySize(element, diagramMode(naturalWidth, availableWidth, chosen), naturalWidth);
      }
    } catch {
      if (current !== sequence) return;
      target.innerHTML = "";
      rendered = null;
      naturalWidth = 0;
      failed = true;
    }
  }

  function resize(mode: DiagramMode): void {
    const element = rendered;
    if (element === null || naturalWidth <= 0) return;
    applySize(element, mode, naturalWidth);
    const viewport = canvas;
    if (viewport !== undefined) {
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
      syncTabStop();
    }
  }

  $effect(() => {
    chosen = null;
    void draw(chart);
    const observer = new MutationObserver(() => void draw(chart));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  });

  $effect(() => {
    const viewport = canvas;
    if (viewport === undefined) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(viewport);
    measure();
    return () => observer.disconnect();
  });

  $effect(() => {
    resize(mode);
  });
</script>

<div class="discover-diagram-figure">
  <div class="discover-diagram__bar">
    <p class="discover-diagram__legend">Arrows point from a context to the context it uses.</p>
    {#if zoomable}
      <Button
        variant="ghost"
        size="sm"
        data-testid="discover-dependency-zoom"
        aria-label={mode === "fit"
          ? "Show the dependency graph at actual size"
          : "Fit the dependency graph to the panel"}
        onclick={() => (chosen = mode === "fit" ? "actual" : "fit")}
      >
        {mode === "fit" ? "Actual size" : "Fit width"}
      </Button>
    {/if}
  </div>
  <div
    class="discover-diagram__canvas"
    data-testid="discover-dependency-canvas"
    role="group"
    aria-label="Dependency graph canvas"
    bind:this={canvas}
  >
    <div
      class="discover-diagram"
      data-testid="discover-dependency-diagram"
      role="img"
      aria-label={label}
      bind:this={host}
    ></div>
  </div>
  {#if failed}
    <p class="empty">The dependency diagram could not be rendered.</p>
  {/if}
</div>
