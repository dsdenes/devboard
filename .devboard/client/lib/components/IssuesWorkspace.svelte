<script lang="ts">
  import { issues, isGoalIssue } from "../issues.svelte";
  import { versionLabel } from "../issues-label";
  import { isProcessing, queueCounts, queueSummary } from "../issues-queue";
  import type { WorkspaceTab } from "../layout.svelte";
  import { statusTone } from "../status-tone";
  import Button from "./ui/button.svelte";
  import CommandButton from "./CommandButton.svelte";
  import DraftsPage from "./DraftsPage.svelte";
  import IssuesAgentFocus from "./IssuesAgentFocus.svelte";
  import IssuesAgentLog from "./IssuesAgentLog.svelte";
  import IssuesQuestion from "./IssuesQuestion.svelte";
  import PageHeader from "./ui/page-header.svelte";
  import { pollStatus } from "../poll-status";

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
              : "overview",
  );

  const queueState = $derived(queueCounts(issues.queue));
  const polled = $derived(
    (issues.snapshot?.sync?.lastSyncAt ?? null) !== null ||
      (issues.snapshot?.poll?.lastPollAt ?? null) !== null,
  );
  const agents = $derived(issues.agents);
  const asking = $derived(agents.filter((agent) => agent.question !== null).length);

  let selectedRunId = $state<string | null>(null);
  // The newest selection wins; when that run ends, the first live agent takes
  // the output pane so it never shows a stale stream.
  const selectedAgent = $derived(
    agents.find((agent) => agent.runId === selectedRunId) ?? agents[0] ?? null,
  );

  let now = $state(Date.now());
  const poll = $derived(pollStatus(issues.snapshot, now));
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

  function startedClock(startedAt: string): string {
    const start = new Date(startedAt);
    if (Number.isNaN(start.getTime())) return startedAt;
    return start.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
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

  function openOverview(): void {
    openTab?.({ id: "overview", kind: "overview", resourceId: "overview", title: "Overview" });
  }

  function runStatus(runId: string): string {
    return issues.runs.find((run) => run.runId === runId)?.status ?? "unknown";
  }
</script>

{#if page === "overview"}
  <section class="issues-overview" data-testid="issues-overview" aria-label="Issues overview">
    <header class="issues-overview__header">
      <div>
        <h1 class="issues-overview__title">Issue automation</h1>
        <p class="issues-overview__repo mono" data-testid="issues-repo" title={issues.repoLabel}>
          {issues.repoLabel}
        </p>
      </div>
    </header>

    <div class="issues-overview__body">
      <div class="issues-overview__side" data-testid="issues-overview-side">
      <section class="panel">
        <div class="panel__header">
          <h2 class="panel__title">Automation</h2>
          <span
            class="panel__subtitle issues-poll"
            data-tone={poll.tone}
            data-testid="issues-poll"
            title={poll.title}
          >
            <span class="issues-poll__dot" aria-hidden="true"></span>
            <span class="issues-poll__label" data-testid="issues-poll-text">{poll.text}</span>
          </span>
        </div>
        <div class="panel__body stack-sm">
          <div class="toolbar">
            <CommandButton
              variant="default"
              label="Start"
              evidence={() => issues.lifecycle}
              command={() => issues.start()}
              data-testid="issues-start"
              data-command="issues.start"
              disabled={!issues.canStart}
            >
              Start
            </CommandButton>
            <CommandButton
              variant="outline"
              label="Pause"
              evidence={() => issues.lifecycle}
              command={() => issues.pause()}
              data-testid="issues-pause"
              data-command="issues.pause"
              disabled={!issues.canPause}
            >
              Pause
            </CommandButton>
            <CommandButton
              variant="outline"
              label="Resume"
              evidence={() => issues.lifecycle}
              command={() => issues.resume()}
              data-testid="issues-resume"
              data-command="issues.resume"
              disabled={!issues.canResume}
            >
              Resume
            </CommandButton>
            <CommandButton
              variant="destructive"
              label="Stop"
              evidence={() => issues.lifecycle}
              command={() => issues.stop()}
              data-testid="issues-stop"
              data-command="issues.stop"
              disabled={!issues.canStop}
            >
              Stop
            </CommandButton>
            <CommandButton
              variant="outline"
              label="Check now"
              evidence={() => issues.snapshot}
              command={() => issues.check()}
              data-testid="issues-check-now"
              data-command="issues.check"
              disabled={!issues.canCheck}
            >
              Check now
            </CommandButton>
          </div>
          <dl class="issues-facts">
            <div>
              <dt>Worker</dt>
              <dd class="mono">
                {issues.snapshot?.worker === null || issues.snapshot?.worker === undefined
                  ? "none"
                  : `pid ${issues.snapshot.worker.pid} · ${versionLabel(issues.snapshot.worker.harnessVersion)}`}
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

      <section class="panel">
        <div class="panel__header">
          <h2 class="panel__title">Running agents</h2>
          {#if asking > 0}
            <span
              class="badge"
              data-tone="warning"
              data-testid="issues-overview-asking"
              title={`${asking} ${asking === 1 ? "agent needs" : "agents need"} an answer`}
            >
              {asking} {asking === 1 ? "needs answer" : "need answers"}
            </span>
          {/if}
        </div>
        <div class="panel__body panel__body--flush">
          <ol class="issues-agent-summary" data-testid="issues-agent-summary">
            {#each agents as agent (agent.runId)}
              {@const issueHref = issueUrl(agent.issueNumber)}
              <li class="issues-agent-summary__item">
                <div
                  class="issues-agent-row"
                  data-run={agent.runId}
                  data-issue={agent.issueNumber}
                  title={issueTitle(agent.issueNumber)}
                  aria-current={selectedAgent?.runId === agent.runId}
                >
                  {#if issueHref}
                    <a
                      class="issues-agent-row__issue mono"
                      data-testid="issues-agent-row-issue"
                      href={issueHref}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open issue #${agent.issueNumber}: ${issueTitle(agent.issueNumber)}`}
                    >
                      #{agent.issueNumber}
                    </a>
                  {:else}
                    <span class="issues-agent-row__issue mono" data-testid="issues-agent-row-issue">
                      #{agent.issueNumber}
                    </span>
                  {/if}
                  <Button
                    bare
                    class="issues-agent-row__open"
                    data-command="issues.agent.open"
                    data-run={agent.runId}
                    data-issue={agent.issueNumber}
                    onclick={() => (selectedRunId = agent.runId)}
                  >
                    <span class="issues-agent-row__title">{issueTitle(agent.issueNumber)}</span>
                    <span class="issues-agent-row__meta">
                      {#if agent.question !== null}
                        <span class="badge" data-tone="warning">needs answer</span>
                      {/if}
                      <span
                        class="issues-version mono"
                        data-testid="issues-agent-row-version"
                        data-run={agent.runId}
                        title={`Worker ${versionLabel(issues.versionForRun(agent.runId))}`}
                      >
                        {versionLabel(issues.versionForRun(agent.runId))}
                      </span>
                      <span
                        class="issues-agent-row__elapsed mono"
                        title={`Started ${startedClock(agent.startedAt)}`}
                      >
                        {elapsedShort(agent.startedAt)}
                      </span>
                    </span>
                  </Button>
                </div>
                <!-- The server's answer for this issue, accepted or refused: a
                     refusal releases the label on the frame that carries it. -->
                <CommandButton
                  bare
                  label="Close"
                  evidence={() => issues.closeRevision(agent.issueNumber)}
                  command={() => issues.closeIssue(agent.issueNumber)}
                  class="issues-agent-row__close"
                  data-testid="issues-close-issue"
                  data-issue={agent.issueNumber}
                  title={`Close issue #${agent.issueNumber} as not planned`}
                  aria-label={`Close issue #${agent.issueNumber}`}
                  disabled={!issues.canClose(agent.issueNumber)}
                >
                  Close
                </CommandButton>
              </li>
            {:else}
              <li class="issues-agent-summary__empty">No agents running.</li>
            {/each}
          </ol>
        </div>
      </section>
      </div>

      {#if selectedAgent !== null}
        <section
          class="panel issues-agent-output"
          data-testid="issues-overview-output"
          data-run={selectedAgent.runId}
          data-issue={selectedAgent.issueNumber}
        >
          <div class="panel__header">
            <h2 class="panel__title" data-testid="issues-overview-output-title">
              #{selectedAgent.issueNumber} · {issueTitle(selectedAgent.issueNumber)}
            </h2>
          </div>
          <div class="panel__body stack-sm">
            <IssuesAgentLog
              lines={issues.activityFor(selectedAgent.runId)}
              testid="issues-overview-activity"
              runId={selectedAgent.runId}
            />
            {#if selectedAgent.question}
              <IssuesQuestion
                runId={selectedAgent.runId}
                question={selectedAgent.question}
                testid="issues-overview-question"
              />
            {/if}
          </div>
        </section>
      {:else}
        <section class="panel" data-testid="issues-overview-output">
          <div class="panel__header">
            <h2 class="panel__title">Agent output</h2>
            <span class="panel__subtitle">No active run</span>
          </div>
          <div class="panel__body">
            <p class="muted">No issue is running.</p>
          </div>
        </section>
      {/if}
    </div>
  </section>
{:else if page === "agents"}
  <section class="issues-agents-page" data-testid="issues-agents-page" aria-label="Running agents">
    <PageHeader
      eyebrow="Issues"
      title="Agents"
      subtitle={issues.repoLabel}
      testid="issues-agents-header"
    >
      {#snippet meta()}
        <span class="badge" data-tone="accent" data-testid="issues-agents-count">
          {agents.length} running
        </span>
        {#if asking > 0}
          <span class="badge" data-tone="warning" data-testid="issues-agents-asking">
            {asking} {asking === 1 ? "needs an answer" : "need answers"}
          </span>
        {/if}
        {#if (issues.snapshot?.workers ?? []).length > 0}
          <span class="issues-workers" data-testid="issues-workers" aria-label="Live workers">
            {#each issues.snapshot?.workers ?? [] as worker (worker.pid)}
              <span
                class="mono"
                data-testid="issues-worker"
                data-version={versionLabel(worker.version)}
                data-pid={worker.pid}
              >
                {versionLabel(worker.version)}
              </span>
            {/each}
          </span>
        {/if}
      {/snippet}
    </PageHeader>
    {#if agents.length === 0}
      <section class="panel issues-agents-empty" data-testid="issues-agents-empty">
        <div class="panel__body stack-sm">
          <h2 class="issues-agents-empty__title">No agents running</h2>
          <p class="muted">Start the issues worker from Overview to see agents here.</p>
          <div class="toolbar">
            <Button
              variant="outline"
              data-testid="issues-agents-overview"
              data-command="open.issues.overview"
              onclick={openOverview}
            >
              Open Overview
            </Button>
          </div>
        </div>
      </section>
    {:else}
      <div class="issues-agent-grid" data-testid="issues-agents">
        {#each agents as agent (agent.runId)}
          {@const status = issues.statusFor(agent.runId)}
          {@const title = issueTitle(agent.issueNumber)}
          {@const issueHref = issueUrl(agent.issueNumber)}
          <article
            class="issues-agent"
            data-testid="issues-agent"
            data-issue={agent.issueNumber}
            data-run={agent.runId}
            data-status={status}
            data-asked={agent.question ? "true" : undefined}
            aria-labelledby={`issues-agent-title-${agent.issueNumber}`}
          >
            <header class="issues-agent__head">
              {#if issueHref}
                <a
                  class="issues-agent__issue mono"
                  href={issueHref}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open issue #${agent.issueNumber}: ${title}`}
                >
                  #{agent.issueNumber}
                </a>
              {:else}
                <span class="issues-agent__issue mono">#{agent.issueNumber}</span>
              {/if}
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
            <h2 class="issues-agent__title" id={`issues-agent-title-${agent.issueNumber}`} title={title}>
              {title}
            </h2>
            <p class="issues-agent__meta mono" title={`Started ${agent.startedAt}`}>
              <span
                class="issues-version"
                data-testid="issues-agent-version"
                data-run={agent.runId}
              >
                worker {versionLabel(issues.versionForRun(agent.runId))}
              </span>
              <span aria-hidden="true">·</span>
              <span>{elapsed(agent.startedAt)} elapsed</span>
              <span aria-hidden="true">·</span>
              <span>started {startedClock(agent.startedAt)}</span>
            </p>
            <div class="issues-agent__activity">
              <p class="issues-agent__activity-label">Latest activity</p>
              <IssuesAgentLog
                lines={issues.activityFor(agent.runId)}
                testid="issues-agent-activity"
                runId={agent.runId}
              />
            </div>
            {#if agent.question}
              <IssuesQuestion
                runId={agent.runId}
                question={agent.question}
                testid="issues-agent-question"
              />
            {/if}
          </article>
        {/each}
      </div>
    {/if}
  </section>
{:else if page === "agent" && tab !== null}
  <IssuesAgentFocus {tab} close={() => closeFocus(tab)} openRuns={openRuns} />
{:else if page === "queue"}
  <section class="issues-queue-page" aria-label="Open issues">
    <header class="issues-overview__header">
      <div>
        <h1 class="issues-overview__title">Open issues</h1>
        <p class="issues-overview__repo mono" title={issues.repoLabel}>{issues.repoLabel}</p>
      </div>
      <span
        class="badge"
        data-tone={statusTone(queueState.working > 0 ? "running" : "pending")}
        data-testid="issues-queue-summary"
      >
        {queueSummary(queueState)}
      </span>
    </header>
    <div class="panel">
      <div class="panel__header">
        <h2 class="panel__title">Queue</h2>
      </div>
      <div class="panel__body panel__body--flush">
        <ol class="issues-queue" data-testid="issues-queue">
          {#each issues.queue as issue (issue.number)}
            <li
              class="issues-queue__item"
              data-testid="issues-queue-item"
              data-number={issue.number}
              data-goal={isGoalIssue(issue)}
              data-processing={isProcessing(issue)}
            >
              <a
                class="issues-queue__number mono"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                title={`Open issue #${issue.number} on the tracker`}
              >
                #{issue.number}
              </a>
              <span class="issues-queue__title" title={issue.title}>{issue.title}</span>
              <span class="issues-queue__meta">
                {#if isGoalIssue(issue)}
                  <span class="badge" data-tone="accent" data-testid="issues-goal-badge">goal</span>
                {/if}
                {#if isProcessing(issue)}
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
              </span>
            </li>
          {:else}
            <li class="issues-queue__empty muted">
              {polled ? "No open issues." : "No open issues have been polled yet."}
            </li>
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
        <h1 class="issues-overview__title">Runs</h1>
        <p class="issues-overview__repo mono" title={issues.repoLabel}>{issues.repoLabel}</p>
      </div>
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
              <Button
                bare
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
                <span class="issues-version mono" data-testid="issues-run-version" data-run={run.runId}>
                  {versionLabel(run.harnessVersion)}
                </span>
                <span class="muted">{run.issueNumbers.map((number) => `#${number}`).join(" ")}</span>
              </Button>
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
            <p class="muted mono" data-testid="issues-run-version-detail">
              worker pid {issues.run.workerPid} · harness {versionLabel(issues.run.harnessVersion)}
            </p>
            <p class="muted">{issues.run.issues.map((issue) => `#${issue.number}`).join(" ")}</p>
            <pre class="issues-activity mono" data-testid="issues-run-activity">{issues.run.activityLines.join("\n") || "No activity."}</pre>
          </div>
        {/if}
      </div>
    </div>
  </section>
{/if}
