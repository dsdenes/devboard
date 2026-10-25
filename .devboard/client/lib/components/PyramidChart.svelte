<script lang="ts">
  import { humanize } from "../discover-format";
  import type { PyramidTier } from "../discover-format";

  interface Props {
    tiers: PyramidTier[];
    /** Half-size chart for a two-column surface. */
    compact?: boolean;
    "data-testid"?: string;
  }

  let { tiers, compact = false, "data-testid": testid }: Props = $props();

  const WIDTH = $derived(compact ? 220 : 400);
  const PLOT_HEIGHT = $derived(compact ? 132 : 184);
  const CENTER = $derived(WIDTH / 2);
  const MIN_HALF = $derived(compact ? 34 : 58);
  const MAX_HALF = $derived(compact ? 98 : 178);

  // The pyramid is drawn from the apex down, so the widest tier sits at the base.
  const bands = $derived.by(() => {
    const count = tiers.length;
    const ordered = [...tiers].reverse();
    return ordered.map((tier, index) => {
      const topHalf = MIN_HALF + ((MAX_HALF - MIN_HALF) * index) / count;
      const bottomHalf = MIN_HALF + ((MAX_HALF - MIN_HALF) * (index + 1)) / count;
      const y0 = (PLOT_HEIGHT * index) / count;
      const y1 = (PLOT_HEIGHT * (index + 1)) / count;
      return {
        tier,
        index,
        points: [
          `${CENTER - topHalf},${y0}`,
          `${CENTER + topHalf},${y0}`,
          `${CENTER + bottomHalf},${y1}`,
          `${CENTER - bottomHalf},${y1}`,
        ].join(" "),
        labelY: (y0 + y1) / 2 + 4,
        opacity: 0.22 + (0.5 * (index + 1)) / count,
      };
    });
  });

  const summary = $derived(
    tiers.map((tier) => `${humanize(tier.level)}: ${tier.tests}`).join(", "),
  );
</script>

<figure class="pyramid" class:pyramid--compact={compact} data-testid={testid}>
  {#if bands.length === 0}
    <p class="empty">No test levels were detected.</p>
  {:else}
    <svg
      class="pyramid__svg"
      viewBox={`0 0 ${WIDTH} ${PLOT_HEIGHT}`}
      role="img"
      aria-label="Test pyramid"
    >
      <title>Test pyramid</title>
      <desc>{summary}</desc>
      {#each bands as band (band.tier.level)}
        <polygon
          points={band.points}
          class="pyramid__band"
          style={`fill-opacity: ${band.opacity.toFixed(2)};`}
          data-level={band.tier.level}
        />
        <text
          class="pyramid__label"
          x={CENTER}
          y={band.labelY}
          text-anchor="middle"
        >
          {humanize(band.tier.level)}{compact
            ? ""
            : ` · ${band.tier.tests === "unknown"
              ? "count unknown"
              : `${band.tier.tests} ${band.tier.tests === "1" ? "test" : "tests"}`}`}
        </text>
      {/each}
    </svg>
  {/if}
</figure>

<style>
  .pyramid {
    margin: 0;
    width: 100%;
  }

  .pyramid--compact {
    width: 220px;
  }

  .pyramid__svg {
    display: block;
    height: auto;
    max-height: 220px;
    width: 100%;
  }

  .pyramid__band {
    fill: var(--accent);
    stroke: var(--background);
    stroke-width: 1.5;
  }

  .pyramid__label {
    fill: var(--foreground);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
  }

  .pyramid--compact .pyramid__label {
    font-size: 9.5px;
  }

  .pyramid--compact .pyramid__svg {
    max-height: 132px;
    width: 220px;
  }
</style>
