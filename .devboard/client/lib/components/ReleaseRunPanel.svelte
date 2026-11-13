<script lang="ts">
  import { elapsedText, type ReleaseGateView, type ReleaseRunView } from "../release-run";
  import ReleaseProgressLog from "./ReleaseProgressLog.svelte";

  interface Props {
    run: ReleaseRunView | null;
    gate: ReleaseGateView | null;
    /** The worker's next due tick, ISO 8601. */
    nextRunAt: string | null;
  }

  let { run, gate, nextRunAt }: Props = $props();

  function stamp(value: string | null): string {
    if (value === null) return "never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
</script>

<section class="panel release-run" aria-label="Release run" data-testid="release-run">
  <div class="panel__header">
    <h2 class="panel__title">Current run</h2>
    <span class="panel__subtitle" data-testid="release-run-state">
      {run === null ? "idle" : "releasing"}
    </span>
  </div>
  <div class="panel__body release-run__body">
    {#if run !== null}
      <dl class="release-run__facts">
        <div>
          <dt>Phase</dt>
          <dd data-testid="release-run-phase" data-phase={run.phase ?? "starting"}>
            {run.phase ?? "starting"}
            <span class="mono release-run__elapsed" data-testid="release-run-phase-elapsed">
              {elapsedText(run.phaseElapsedMs)}
            </span>
          </dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd class="mono" data-testid="release-run-range">{run.range}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd class="mono" data-testid="release-run-version">{run.version ?? "—"}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd class="mono" data-testid="release-run-target">{run.target}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd class="mono" data-testid="release-run-elapsed">{elapsedText(run.elapsedMs)}</dd>
        </div>
        {#if run.peerPid !== null}
          <div>
            <dt>Peer</dt>
            <dd class="mono" data-testid="release-run-peer">pid {run.peerPid}</dd>
          </div>
        {/if}
      </dl>
      <ReleaseProgressLog records={run.records} identity={run.id} />
    {:else}
      <p class="release-run__idle" data-testid="release-run-idle">No release run is active.</p>
    {/if}
    {#if gate !== null}
      <p class="release-run__gate" data-testid="release-run-gate">
        Gate <span class="mono" data-testid="release-run-gate-state">{gate.state}</span>
        {#if gate.range !== null}
          · range <span class="mono" data-testid="release-run-gate-range">{gate.range}</span>
        {/if}
        {#if gate.version !== null}
          · v<span class="mono" data-testid="release-run-gate-version">{gate.version}</span>
        {/if}
        {#if gate.target !== null}
          · target <span class="mono" data-testid="release-run-gate-target">{gate.target}</span>
        {/if}
      </p>
    {/if}
    <p class="release-run__next" data-testid="release-run-next">
      Next tick <span class="mono">{stamp(nextRunAt)}</span>
    </p>
  </div>
</section>

<style>
  .release-run__body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .release-run__facts {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 1.75rem;
    margin: 0;
  }

  .release-run__facts dt {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted-foreground);
  }

  .release-run__facts dd {
    margin: 0;
    font-size: 0.875rem;
  }

  .release-run__elapsed {
    color: var(--muted-foreground);
    margin-left: 0.375rem;
  }

  .release-run__gate,
  .release-run__next,
  .release-run__idle {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--muted-foreground);
  }
</style>
