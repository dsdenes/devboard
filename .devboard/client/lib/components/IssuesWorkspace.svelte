<script lang="ts">
  import { issues, isGoalIssue } from "../issues.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import DraftsPage from "./DraftsPage.svelte";
  import IssuesAgentFocus from "./IssuesAgentFocus.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import IssuesAgentQuestion from "./IssuesAgentQuestion.svelte";
  import ScoutWorkspace from "./ScoutWorkspace.svelte";

  interface Props {
    tab: WorkspaceTab | null;
    openTab?: (tab: WorkspaceTab) => void;
    closeTab?: (tab: WorkspaceTab) => void;
  }

  let { tab, openTab, closeTab }: Props = $props();

  const page = $derived(
    tab?.kind === "drafts"
      ? "drafts"
      : tab?.kind === "queue"
        ? "queue"
        : tab?.kind === "runs"
          ? "runs"
          : tab?.kind === "agents"
            ? "agents"
            : tab?.kind === "agent"
              ? "agent"
              : tab?.kind === "scout"
                ? "scout"
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
  const agents = $derived(issues.agents);

  let now = $state(Date.now());
  $effect(() => {
    if (page !== "agents" && page !== "overview") return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function issueTitle(number: number): string {
    return issues.queue.find((issue) => issue.number === number)?.title ?? `Issue ${number}`;
  }

  function issueUrl(number: number): string {
    return issues.queue.find((issue) => issue.number === number)?.url ?? "";
  }

  function elapsed(startedAt: string): string {
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) return startedAt;
    const seconds = Math.max(0, Math.round((now - start) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
  }

  /** One glanceable duration for a summary row: `12s`, `7m`, `2h 5m`. */
  function elapsedShort(startedAt: string): string {
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) return startedAt;
    const seconds = Math.max(0, Math.round((now - start) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function openAgent(runId: string, issueNumber: number): void {
    openTab?.({
      id: `agent:${runId}`,
      kind: "agent",
      resourceId: runId,
      title: `#${issueNumber} ${issueTitle(issueNumber)}`,
    });
  }

  function closeFocus(current: WorkspaceTab): void {
    closeTab?.(current);
  }

  function openRuns(): void {
    openTab?.({ id: "runs", kind: "runs", resourceId: "runs", title: "Runs" });
  }

  function openAgents(): void {
    openTab?.({ id: "agents", kind: "agents", resourceId: "agents", title: "Agents" });
  }

  function runStatus(runId: string): string {
    return issues.runs.find((run) => run.runId === runId)?.status ?? "unknown";
  }
</script>

{#if page === "scout"}
  <ScoutWorkspace />
{:else if page === "overview"}
  <section class="issues-overview" data-testid="issues-overview" aria-label="Issues overview">
    <header class="issues-overview__header">
      <div>
        <h1 class="issues-overview__title">Issue automation</h1>
        <p class="issues-overview__repo mono" data-testid="issues-repo">
          {issues.repo ?? "No GitHub origin"}
        </p>
      </div>
      <span class="badge" data-tone={statusTone(stateWord)} data-testid="issues-state">
        {stateWord}
      </span>
    </header>

    <div class="issues-overview__body">
      <section class="panel">
        <div class="panel__header">
          <h2 class="panel__title">Automation</h2>
          <span class="panel__subtitle">{pollLine}</span>
        </div>
        <div class="panel__body stack-sm">
          <div class="toolbar">
            <Button
              variant="default"
              data-testid="issues-start"
              data-command="issues.start"
              disabled={!issues.canStart}
              onclick={() => issues.start()}
            >
              Start
            </Button>
            <Button
              variant="outline"
              data-testid="issues-pause"
              data-command="issues.pause"
              disabled={!issues.canPause}
              onclick={() => issues.pause()}
            >
              Pause
            </Button>
            <Button
              variant="outline"
              data-testid="issues-resume"
              data-command="issues.resume"
              disabled={!issues.canResume}
              onclick={() => issues.resume()}
            >
              Resume
            </Button>
            <Button
              variant="destructive"
              data-testid="issues-stop"
              data-command="issues.stop"
              disabled={!issues.canStop}
              onclick={() => issues.stop()}
            >
              Stop
            </Button>
            <Button
              variant="outline"
              data-testid="issues-check-now"
              data-command="issues.check"
              disabled={!issues.canCheck}
              onclick={() => issues.check()}
            >
              Check now
            </Button>
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
              <dt>Agents</dt>
              <dd data-testid="issues-running-agents">{agents.length} running</dd>
            </div>
            <div>
              <dt>Queue</dt>
              <dd>{issues.pending} pending · {issues.queue.length} open</dd>
            </div>
            <div>
              <dt>Cooldowns</dt>
              <dd class="mono" data-testid="issues-cooldowns">
                {issues.cooldownCount} cooling · earliest {issues.earliestCooldown ?? "none"}
              </dd>
            </div>
            <div>
              <dt>Runs</dt>
              <dd>{runCount} kept</dd>
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
          <Button variant="outline" data-testid="issues-agents-link" data-command="open.issues.agents" onclick={openAgents}>
            Open Agents
          </Button>
        </div>
      </section>

      <section class="panel">
        <div class="panel__header">
          <h2 class="panel__title">Running agents</h2>
          <span class="panel__subtitle">{agents.length} active</span>
        </div>
        <div class="panel__body panel__body--flush">
          <ol class="issues-agent-summary" data-testid="issues-agent-summary">
            {#each agents as agent (agent.runId)}
              <li>
                <button
                  type="button"
                  class="issues-agent-row"
                  data-command="issues.agent.open"
                  data-run={agent.runId}
                  data-issue={agent.issueNumber}
                  title={issueTitle(agent.issueNumber)}
                  onclick={() => openAgent(agent.runId, agent.issueNumber)}
                >
                  <span class="issues-agent-row__issue mono">#{agent.issueNumber}</span>
                  <span class="issues-agent-row__title">{issueTitle(agent.issueNumber)}</span>
                  <span class="issues-agent-row__meta">
                    {#if agent.question !== null}
                      <span class="badge" data-tone="warning">needs answer</span>
                    {/if}
                    <span class="issues-agent-row__elapsed mono">{elapsedShort(agent.startedAt)}</span>
                  </span>
                </button>
              </li>
            {:else}
              <li class="issues-agent-summary__empty muted">No issue is running.</li>
            {/each}
          </ol>
        </div>
      </section>
    </div>
  </section>
{:else if page === "agents"}
  <section class="issues-agents-page" data-testid="issues-agents-page" aria-label="Running agents">
    <header class="issues-overview__header">
      <div>
        <p class="muted">Issues</p>
        <h1 class="issues-overview__title">Agents</h1>
        <p class="issues-overview__repo mono">{issues.repo ?? "No GitHub origin"}</p>
      </div>
      <span class="badge" data-tone="accent" data-testid="issues-agents-count">{agents.length} running</span>
    </header>
    <div class="issues-agent-grid" data-testid="issues-agents">
      {#each agents as agent (agent.runId)}
        <article
          class="issues-agent"
          data-testid="issues-agent"
          data-issue={agent.issueNumber}
          data-run={agent.runId}
          data-status={issues.statusFor(agent.runId)}
        >
          <header class="toolbar toolbar--between">
            <a class="mono" href={issueUrl(agent.issueNumber)} target="_blank" rel="noreferrer">
              #{agent.issueNumber}
            </a>
            <span class="issues-agent__title">{issueTitle(agent.issueNumber)}</span>
            <Button
              variant="outline"
              data-testid="issues-agent-open"
              data-run={agent.runId}
              data-command="issues.agent.open"
              onclick={() => openAgent(agent.runId, agent.issueNumber)}
            >
              Focus
            </Button>
          </header>
          <dl class="issues-facts">
            <div>
              <dt>Run</dt>
              <dd class="mono">{agent.runId}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd class="mono">{agent.startedAt} · {elapsed(agent.startedAt)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span class="badge" data-tone={statusTone(issues.statusFor(agent.runId))}>
                  {issues.statusFor(agent.runId)}
                </span>
              </dd>
            </div>
          </dl>
          <IssuesAgentLog lines={issues.activityFor(agent.runId)} testid="issues-agent-activity" runId={agent.runId} />
          {#if agent.question}
            <IssuesAgentQuestion runId={agent.runId} question={agent.question} testid="issues-agent-question" />
          {/if}
        </article>
      {:else}
        <p class="muted">No issue is running.</p>
      {/each}
    </div>
  </section>
{:else if page === "agent" && tab !== null}
  <IssuesAgentFocus {tab} close={() => closeFocus(tab)} openRuns={openRuns} />
{:else if page === "queue"}
  <section class="issues-queue-page" aria-label="Open issues">
    <header class="issues-overview__header">
      <div>
        <p class="muted">Issues</p>
        <h1 class="issues-overview__title">Open issues</h1>
        <p class="issues-overview__repo mono">{issues.repo ?? "No GitHub origin"}</p>
      </div>
      <span class="badge" data-tone={statusTone("pending")}>{issues.pending} pending</span>
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
              data-run={issue.agentRunId ?? ""}
            >
              <a class="mono" href={issue.url} target="_blank" rel="noreferrer">#{issue.number}</a>
              <span class="issues-queue__title">{issue.title}</span>
              {#if isGoalIssue(issue)}
                <span class="badge" data-tone="accent" data-testid="issues-goal-badge">goal</span>
              {/if}
              {#if issue.handled}
                <span class="badge" data-tone={statusTone("handled")}>handled</span>
              {:else if issue.agentRunId !== null}
                <span
                  class="badge"
                  data-tone={statusTone("running")}
                  data-testid="issues-running-marker"
                >
                  running
                </span>
              {:else}
                <span class="badge" data-tone={statusTone("pending")}>pending</span>
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
        <span class="panel__subtitle">Newest 50 plus every running run</span>
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
                <span class="badge" data-tone={statusTone(run.status)}>
                  {run.status}
                </span>
                <span class="muted">{run.issueNumbers.map((number) => `#${number}`).join(" ")}</span>
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
              <span class="badge" data-tone={statusTone(runStatus(issues.run.runId))}>
                {runStatus(issues.run.runId)}
              </span>
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
