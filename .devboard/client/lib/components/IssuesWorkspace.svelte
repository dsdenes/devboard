<script lang="ts">
  import { issues, isGoalIssue } from "../issues.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import Button from "./ui/button.svelte";
  import DraftsPage from "./DraftsPage.svelte";
  import Input from "./ui/input.svelte";

  interface Props {
    tab: WorkspaceTab | null;
  }

  let { tab }: Props = $props();

  const page = $derived(
    tab?.kind === "drafts"
      ? "drafts"
      : tab?.kind === "queue"
        ? "queue"
        : tab?.kind === "runs"
          ? "runs"
          : "overview",
  );

  const stateWord = $derived(issues.lifecycle);
  const nextCheck = $derived(issues.snapshot?.poll?.nextPollAt ?? null);
  const pollLine = $derived(
    issues.snapshot?.poll === null || issues.snapshot?.poll === undefined
      ? "Not polling"
      : `Every ${Math.round(issues.snapshot.poll.intervalMs / 100) / 10}s · last ${
          issues.snapshot.poll.lastPollAt ?? "never"
        } · next ${nextCheck ?? "not scheduled"}`,
  );
  const runCount = $derived(issues.runs.length);
  const activityText = $derived(
    issues.activity.length === 0 ? "No activity yet." : issues.activity.join("\n"),
  );
  const agents = $derived(issues.agents);
  let agentAnswers = $state<Record<string, string>>({});

  let activityElement = $state<HTMLPreElement | null>(null);
  let followActivity = $state(true);

  // Reading the tracked values keeps the activity pinned to its newest line
  // unless the operator scrolled back through the log.
  $effect(() => {
    void activityText;
    void issues.question;
    if (!followActivity || activityElement === null) return;
    activityElement.scrollTop = activityElement.scrollHeight;
  });

  // A taller or shorter viewport changes how much of the log fits; a follower
  // stays on the newest line instead of drifting away from it.
  $effect(() => {
    const element = activityElement;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      if (!followActivity) return;
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  function trackActivityFollow(event: Event & { currentTarget: HTMLPreElement }): void {
    const element = event.currentTarget;
    followActivity = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
  }

  function runStatus(runId: string): string {
    return issues.runs.find((run) => run.runId === runId)?.status ?? "unknown";
  }
</script>

{#if page === "overview"}
  <section class="issues-overview" data-testid="issues-overview" aria-label="Issues overview">
    <header class="issues-overview__header">
      <div>
        <p class="muted">Issues</p>
        <h1 class="issues-overview__title">Issue automation</h1>
        <p class="issues-overview__repo mono" data-testid="issues-repo">
          {issues.repo ?? "No GitHub origin"}
        </p>
      </div>
      <span class="badge" data-tone={stateWord === "failed" ? "error" : stateWord === "running" ? "accent" : "warning"} data-testid="issues-state">
        {stateWord}
      </span>
    </header>

    <div class="issues-overview__body">
      <div class="issues-overview__side">
      <section class="panel">
        <div class="panel__header">
          <h2 class="panel__title">Automation</h2>
          <span class="panel__subtitle">{pollLine}</span>
        </div>
        <div class="panel__body stack-sm">
          <div class="toolbar">
            <Button
              variant={issues.enabled ? "destructive" : "default"}
              data-testid="issues-toggle"
              data-command="issues.toggle"
              disabled={!issues.canStart && !issues.canStop}
              onclick={() => issues.toggle()}
            >
              {issues.enabled ? "Stop" : "Start"}
            </Button>
            <span class="muted">
              {issues.enabled
                ? "The worker polls and starts one run for the open issues."
                : "Start the worker to poll the open issues and implement them."}
            </span>
          </div>
          <dl class="issues-facts">
            <div>
              <dt>Worker</dt>
              <dd class="mono">
                {issues.snapshot?.worker === null || issues.snapshot?.worker === undefined
                  ? "none"
                  : `pid ${issues.snapshot.worker.pid} · ${issues.snapshot.worker.harnessVersion ?? "unknown"}`}
              </dd>
            </div>
            <div>
              <dt>Queue</dt>
              <dd>{issues.pending} pending · {issues.queue.length} open</dd>
            </div>
            <div>
              <dt>Runs</dt>
              <dd>{runCount} kept</dd>
            </div>
            <div>
              <dt>Next attempt</dt>
              <dd class="mono">{issues.snapshot?.nextAttemptAt ?? "none"}</dd>
            </div>
          </dl>
          {#if issues.notice !== null}
            <p class="issues-notice" data-testid="issues-notice" role="status">{issues.notice}</p>
          {/if}
          {#if issues.snapshot?.poll?.error ?? issues.snapshot?.lastError ?? null}
            <p class="issues-error" data-testid="issues-error" role="alert">
              {issues.snapshot?.poll?.error ?? issues.snapshot?.lastError}
            </p>
          {/if}
        </div>
      </section>

      <section class="panel issues-activity-panel">
        <div class="panel__header">
          <h2 class="panel__title">Goal agents</h2>
          <span class="panel__subtitle">{agents.length} active</span>
        </div>
        <div class="panel__body stack-sm" data-testid="issues-agents">
          {#each agents as agent (agent.runId)}
            <article
              class="issues-agent"
              data-testid="issues-agent"
              data-issue={agent.issueNumber}
              data-run={agent.runId}
            >
              <header class="toolbar toolbar--between">
                <span class="mono">#{agent.issueNumber}</span>
                <span class="badge" data-tone="accent">goal</span>
                <span class="mono muted">{agent.runId}</span>
              </header>
              <pre class="issues-activity mono" data-testid="issues-agent-activity" data-run={agent.runId}>{
                issues.activityFor(agent.runId).length === 0
                  ? "No activity yet."
                  : issues.activityFor(agent.runId).join("\n")
              }</pre>
              {#if agent.question !== null}
                <div
                  class="issues-question"
                  data-testid="issues-agent-question"
                  data-run={agent.runId}
                  data-issue={agent.issueNumber}
                >
                  <p>{agent.question.message}</p>
                  {#if agent.question.options.length > 0}
                    <div class="choice-list">
                      {#each agent.question.options as option (option.label)}
                        <button
                          type="button"
                          class="choice"
                          data-testid="issues-agent-choice"
                          data-run={agent.runId}
                          data-command="issues.answer"
                          onclick={() =>
                            issues.submitAgentAnswer(agent.runId, agent.question!.id, option.label)}
                        >
                          <span class="choice__label">
                            {option.label}
                            {#if option.recommended}
                              <span class="choice__recommended">Recommended</span>
                            {/if}
                          </span>
                          {#if option.description}
                            <span class="choice__description">{option.description}</span>
                          {/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                  <form
                    class="issues-answer"
                    onsubmit={(event) => {
                      event.preventDefault();
                      issues.submitAgentAnswer(
                        agent.runId,
                        agent.question!.id,
                        agentAnswers[agent.runId] ?? "",
                      );
                      agentAnswers = { ...agentAnswers, [agent.runId]: "" };
                    }}
                  >
                    <Input
                      type="text"
                      value={agentAnswers[agent.runId] ?? ""}
                      oninput={(event) =>
                        (agentAnswers = { ...agentAnswers, [agent.runId]: event.currentTarget.value })}
                      placeholder="Your answer"
                      aria-label={`Your answer for issue ${agent.issueNumber}`}
                      data-testid="issues-agent-answer-input"
                      data-run={agent.runId}
                    />
                    <Button
                      variant="default"
                      type="submit"
                      data-command="issues.answer"
                      data-testid="issues-agent-answer-submit"
                      data-run={agent.runId}
                      disabled={(agentAnswers[agent.runId] ?? "").trim().length === 0}
                    >
                      Answer
                    </Button>
                  </form>
                </div>
              {/if}
            </article>
          {:else}
            <p class="muted">No goal-labeled issue is running.</p>
          {/each}
        </div>
      </section>
      </div>

      <section class="panel issues-activity-panel">
        <div class="panel__header">
          <h2 class="panel__title">Agent activity</h2>
          <span class="panel__subtitle">
            {issues.snapshot?.activeRun === null || issues.snapshot?.activeRun === undefined
              ? "No active run"
              : `Run ${issues.snapshot.activeRun.runId}`}
          </span>
        </div>
        <pre
          class="issues-activity mono"
          data-testid="issues-activity"
          bind:this={activityElement}
          onscroll={trackActivityFollow}
        >{activityText}</pre>
        {#if issues.question !== null}
          <div class="issues-question" data-testid="issues-question">
            <p>{issues.question.message}</p>
            {#if issues.question.options.length > 0}
              <div class="choice-list">
                {#each issues.question.options as option (option.label)}
                  <button
                    type="button"
                    class="choice"
                    data-testid="issues-choice"
                    data-command="issues.answer"
                    onclick={() => issues.submitAnswer(option.label)}
                  >
                    <span class="choice__label">
                      {option.label}
                      {#if option.recommended}
                        <span class="choice__recommended">Recommended</span>
                      {/if}
                    </span>
                    {#if option.description}
                      <span class="choice__description">{option.description}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
            <form
              class="issues-answer"
              onsubmit={(event) => {
                event.preventDefault();
                issues.submitAnswer(issues.answer);
              }}
            >
              <Input
                type="text"
                value={issues.answer}
                oninput={(event) => (issues.answer = event.currentTarget.value)}
                placeholder="Your answer"
                aria-label="Your answer"
                data-testid="issues-answer-input"
              />
              <Button
                variant="default"
                type="submit"
                data-command="issues.answer"
                data-testid="issues-answer-submit"
                disabled={issues.answer.trim().length === 0}
              >
                Answer
              </Button>
            </form>
          </div>
        {/if}
      </section>
    </div>
  </section>
{:else if page === "queue"}
  <section class="issues-queue-page" aria-label="Open issues">
    <header class="issues-overview__header">
      <div>
        <p class="muted">Issues</p>
        <h1 class="issues-overview__title">Open issues</h1>
        <p class="issues-overview__repo mono">{issues.repo ?? "No GitHub origin"}</p>
      </div>
      <span class="badge" data-tone="warning">{issues.pending} pending</span>
      {#if issues.goalPending > 0}
        <span class="badge" data-tone="accent">{issues.goalPending} goal</span>
      {/if}
    </header>
    <div class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Queue</h2>
        <span class="panel__subtitle">Sorted by number</span>
      </div>
      <div class="panel__body panel__body--flush">
        <ol class="issues-queue" data-testid="issues-queue">
          {#each issues.queue as issue (issue.number)}
            <li
              class="issues-queue__item"
              data-testid="issues-queue-item"
              data-number={issue.number}
              data-handled={issue.handled}
              data-goal={isGoalIssue(issue)}
            >
              <a class="mono" href={issue.url} target="_blank" rel="noreferrer">#{issue.number}</a>
              <span class="issues-queue__title">{issue.title}</span>
              {#if isGoalIssue(issue)}
                <span class="badge" data-tone="accent" data-testid="issues-goal-badge">goal</span>
              {/if}
              {#if issue.handled}
                <span class="badge" data-tone="success">handled</span>
              {:else if !isGoalIssue(issue)}
                <span class="badge" data-tone="warning">pending</span>
              {/if}
            </li>
          {:else}
            <li class="issues-queue__empty muted">No open issues have been polled yet.</li>
          {/each}
        </ol>
      </div>
    </div>
  </section>
{:else if page === "drafts"}
  <DraftsPage />
{:else}
  <section class="issues-runs-page" aria-label="Issues runs">
    <header class="issues-overview__header">
      <div>
        <p class="muted">Issues</p>
        <h1 class="issues-overview__title">Runs</h1>
        <p class="issues-overview__repo mono">{issues.repo ?? "No GitHub origin"}</p>
      </div>
      <span class="badge" data-tone="accent">{runCount}</span>
    </header>
    <div class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Run history</h2>
        <span class="panel__subtitle">Newest 50</span>
      </div>
      <div class="panel__body panel__body--flush">
        <ol class="issues-runs" data-testid="issues-runs">
          {#each issues.runs as run (run.runId)}
            <li>
              <button
                type="button"
                class="issues-run"
                data-testid="issues-run"
                data-run={run.runId}
                data-status={run.status}
                data-command="issues.run.open"
                aria-current={issues.selectedRun === run.runId}
                onclick={() => issues.openRun(run.runId)}
              >
                <span class="mono">{run.runId}</span>
                <span class="badge" data-tone={run.status === "failed" ? "error" : run.status === "running" ? "accent" : "success"}>
                  {run.status}
                </span>
                <span class="muted">{run.issueNumbers.length} issue(s)</span>
              </button>
            </li>
          {:else}
            <li class="muted">No runs yet.</li>
          {/each}
        </ol>
        {#if issues.run !== null}
          <div class="issues-run-detail" data-testid="issues-run-detail" data-run={issues.run.runId}>
            <div class="toolbar toolbar--between">
              <h3 class="mono">{issues.run.runId}</h3>
              <span class="badge" data-tone="accent">{runStatus(issues.run.runId)}</span>
            </div>
            <p class="muted mono">{issues.run.cwd}</p>
            <p class="muted">{issues.run.issues.map((issue) => `#${issue.number}`).join(" ")}</p>
            <pre class="issues-activity mono" data-testid="issues-run-activity">{issues.run.activityLines.join("\n") || "No activity."}</pre>
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
