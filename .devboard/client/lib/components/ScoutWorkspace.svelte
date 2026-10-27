<script lang="ts">
  import { scout } from "../scout.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";

  const activityText = $derived(
    scout.activity.length === 0 ? "No activity yet." : scout.activity.join("\n"),
  );
  const lifecycleTone = $derived(statusTone(scout.lifecycle));
  let activityElement = $state<HTMLPreElement | null>(null);

  // Reading the tracked values keeps the activity pinned to its newest line.
  $effect(() => {
    void activityText;
    if (activityElement === null) return;
    activityElement.scrollTop = activityElement.scrollHeight;
  });
</script>

<section class="issues-scout" data-testid="issues-scout" aria-label="Auto Scout">
  <header class="issues-overview__header">
    <div>
      <h1 class="issues-overview__title">Auto Scout</h1>
      <p class="issues-overview__repo mono" data-testid="scout-repo">
        {scout.repo ?? "No GitHub origin"}
      </p>
    </div>
    <span class="badge" data-tone={lifecycleTone} data-testid="scout-lifecycle">
      {scout.lifecycle}
    </span>
  </header>

  <section class="panel">
    <div class="panel__header">
      <h2 class="panel__title">Scout worker</h2>
    </div>
    <div class="panel__body stack-sm">
      <div class="toolbar">
        <Button
          variant={scout.canStop ? "destructive" : "default"}
          data-testid={scout.canStop ? "scout-stop" : "scout-start"}
          data-command={scout.canStop ? "issues.scout.stop" : "issues.scout.start"}
          disabled={!scout.canStop && !scout.canStart}
          onclick={() => (scout.canStop ? scout.stop() : scout.start())}
        >
          {scout.canStop ? "Stop" : "Start"}
        </Button>
      </div>
      <dl class="issues-facts">
        <div>
          <dt>Worker</dt>
          <dd class="mono">
            {scout.snapshot?.worker === null || scout.snapshot?.worker === undefined
              ? "none"
              : `pid ${scout.snapshot.worker.pid} · ${scout.snapshot.worker.harnessVersion ?? "unknown"}`}
          </dd>
        </div>
        <div>
          <dt>Staged</dt>
          <dd>{scout.count} of 9</dd>
        </div>
        <div>
          <dt>Scan</dt>
          <dd class="mono">{scout.snapshot?.scan?.scanId ?? "none"}</dd>
        </div>
        <div>
          <dt>Next attempt</dt>
          <dd class="mono">{scout.nextAttemptAt ?? "none"}</dd>
        </div>
      </dl>
      {#if scout.notice !== null}
        <p class="issues-notice" data-testid="scout-notice" role="status">{scout.notice}</p>
      {/if}
      {#if scout.error !== null}
        <p class="issues-error" data-testid="scout-error" role="alert">{scout.error}</p>
      {/if}
      {#if scout.shortfall !== null}
        <p class="issues-notice" data-testid="scout-shortfall" role="status">{scout.shortfall}</p>
      {/if}
    </div>
  </section>

  <section class="panel issues-activity-panel">
    <div class="panel__header">
      <h2 class="panel__title">Scan activity</h2>
      <span class="panel__subtitle">
        {scout.snapshot?.scan?.scanId ?? scout.snapshot?.newestScanId ?? "No scan yet"}
      </span>
    </div>
    <pre class="issues-activity mono" data-testid="scout-activity" bind:this={activityElement}
      >{activityText}</pre>
  </section>

  <section class="scout-board" aria-label="Staged recommendations">
    {#each scout.staged as item (item.id)}
      <article
        class="panel scout-widget"
        data-testid="scout-widget"
        data-id={item.id}
        data-category={item.category}
      >
        <div class="panel__header">
          <h2 class="panel__title">{item.title}</h2>
          <span class="badge" data-tone="accent">{item.category}</span>
        </div>
        <div class="panel__body stack-sm">
          <p class="scout-widget__summary">{item.summary}</p>
          <p class="scout-widget__impact">
            <strong>Impact.</strong>
            {item.impact.length === 0 ? "Not stated." : item.impact}
          </p>
          <div class="scout-widget__section">
            <h3>Evidence</h3>
            <ul class="scout-widget__list">
              {#each item.evidence as entry (entry.path + entry.lines)}
                <li>
                  <code class="mono">{entry.path}:{entry.lines}</code>
                  {#if entry.quote}
                    <q class="scout-widget__quote">{entry.quote}</q>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
          <div class="scout-widget__section">
            <h3>Proposed change</h3>
            <p>{item.proposedChange}</p>
          </div>
          <div class="scout-widget__section">
            <h3>Files</h3>
            <ul class="scout-widget__list">
              {#each item.files as file (file)}
                <li><code class="mono">{file}</code></li>
              {/each}
            </ul>
          </div>
          <div class="scout-widget__section">
            <h3>Acceptance criteria</h3>
            <ul class="scout-widget__list">
              {#each item.acceptanceCriteria as criterion (criterion)}
                <li>{criterion}</li>
              {/each}
            </ul>
          </div>
          <p class="muted scout-widget__staged mono">Staged {item.stagedAt}</p>
          <div class="toolbar">
            <Button
              variant="default"
              data-testid="scout-approve"
              data-command={`issues.scout.approve.${item.id}`}
              disabled={scout.inFlight(item.id)}
              onclick={() => scout.approve(item.id)}
            >
              Approve
            </Button>
            <Button
              variant="outline"
              data-testid="scout-draft-goal"
              data-command={`issues.scout.draft-goal.${item.id}`}
              disabled={scout.inFlight(item.id)}
              onclick={() => scout.draftGoal(item.id)}
            >
              Draft goal
            </Button>
            <Button
              variant="destructive"
              data-testid="scout-reject"
              data-command={`issues.scout.reject.${item.id}`}
              disabled={scout.inFlight(item.id)}
              onclick={() => scout.reject(item.id)}
            >
              Reject
            </Button>
          </div>
        </div>
      </article>
    {:else}
      <div class="panel scout-empty" data-testid="scout-empty">
        <p>
          {scout.attached
            ? "Nothing is staged. Scouting runs automatically."
            : "Nothing is staged. Start Auto Scout to survey the repository."}
        </p>
      </div>
    {/each}
  </section>
</section>
