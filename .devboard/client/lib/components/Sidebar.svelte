<script lang="ts">
  import Button from "./ui/button.svelte";
  import { DISCOVER_AGENTS } from "../../../lib/agent-registry.ts";
  import { SECTION_TABS, SKILL_TABS } from "../discover-format";
  import {
    agentLifecycleRunState,
    discoverAgentRunState,
    discoverSuiteRunState,
    runStateTone,
    type RunState,
  } from "../run-state";
  import { DEVBOARD_SIDEBAR } from "../devboard.svelte";
  import { discover } from "../discover.svelte";
  import { flow } from "../flow.svelte";
  import { goal } from "../goal.svelte";
  import { goalDrafts } from "../goal-drafts.svelte";
  import { issues } from "../issues.svelte";
  import { queueCounts, queueSummary } from "../issues-queue";
  import { agents } from "../agents.svelte";
  import { statusTone, verificationTone } from "../status-tone";
  import { layout } from "../layout.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import type { DiscoverTab, Mode } from "../types";

  interface Props {
    openTab: (mode: Mode, tab: WorkspaceTab) => void;
    focusLater?: (mode: Mode, selector: string) => Promise<void>;
  }

  let { openTab, focusLater }: Props = $props();

  const active = $derived(layout.activeTab[layout.mode]);
  const issueQueue = $derived(queueCounts(issues.queue));
  const modeLabel = $derived(
    layout.mode === "goal"
      ? "Goal"
      : layout.mode === "issues"
        ? "Issues"
        : layout.mode === "flow"
          ? "Flow"
          : layout.mode === "discover"
            ? "Discover"
            : "Devboard",
  );
  const resolvedCount = $derived(goal.records.filter((record) => !record.pending).length);
  const pendingRecords = $derived(goal.records.filter((record) => record.pending));
  const progressPercent = $derived(
    goal.records.length === 0 ? 0 : Math.round((resolvedCount / goal.records.length) * 100),
  );
  const stageWord = $derived(
    goal.lifecycle.paused
      ? "paused"
      : goal.lifecycle.stage === "goal"
        ? "idle"
        : goal.lifecycle.stage === "epic"
          ? "epics"
          : goal.lifecycle.stage === "adr"
            ? "ADRs"
            : goal.lifecycle.stage === "implementation"
              ? "implementation"
              : "finished",
  );
  const termCount = $derived(
    discover.contexts.reduce(
      (total, context) =>
        total + context.concepts.filter((concept) => concept.status !== "invalidated").length,
      0,
    ),
  );

  function skillState(name: string): "generated" | "edited" | "missing" {
    return discover.skill(name)?.state ?? "missing";
  }

  /** One Discover agent's own entry state; never another agent's or the suite's. */
  function agentRun(id: string): RunState {
    return discoverAgentRunState(
      discover.agent(id)?.state ?? null,
      discover.agentQuestionOf(id) !== null,
    );
  }

  /**
   * A Discover section or skill entry reads only the source its page belongs
   * to: the Overview reads the seven-agent suite, the two page entries read
   * their own agent, and every skill entry reads the agent that owns it.
   */
  function tabRun(tab: DiscoverTab): RunState {
    if (tab.id === "overview") {
      return discoverSuiteRunState(
        discover.runningAll,
        discover.allFailed !== null,
        discover.question !== null,
      );
    }
    if (tab.id === "glossary") return agentRun("discover-glossary");
    if (tab.id === "contribution") return agentRun("discover-contribution");
    return tab.skill === null ? "idle" : agentRun(tab.skill);
  }

  /** The Goal implementation entry: a manual run or the lifecycle's live step. */
  function implementationRun(): RunState {
    const executing = goal.running || (goal.lifecycleActive && !goal.lifecycle.paused);
    if (goal.question !== null && executing) return "answer";
    if (executing) return "running";
    return "idle";
  }

  /** The Issues overview entry: the issues lifecycle and its agents' questions. */
  function issuesOverviewRun(): RunState {
    if (issues.agents.some((agent) => agent.question !== null)) return "answer";
    if (issues.lifecycle === "running" || issues.lifecycle === "pausing") return "running";
    if (issues.lifecycle === "failed") return "failed";
    return "idle";
  }

  /** The Draft goals entry: any live elaboration, a waiting question, its last failure. */
  function draftsRun(): RunState {
    const runs = Object.values(goalDrafts.draftRuns);
    if (runs.some((run) => run.question !== null)) return "answer";
    if (runs.some((run) => run.status === "running")) return "running";
    const finished = runs
      .filter((run) => run.finishedAt !== null)
      .sort(
        (left, right) =>
          (Date.parse(right.finishedAt ?? "") || 0) - (Date.parse(left.finishedAt ?? "") || 0),
      );
    return finished[0]?.status === "failed" ? "failed" : "idle";
  }

  /** The Flow overview and Session status entries read only the Flow session. */
  function flowRun(): RunState {
    if (flow.question !== null) return "answer";
    return flow.status === "running" ? "running" : "idle";
  }

  /** One background-agent entry reads only its own lifecycle. */
  function agentRunState(id: string): RunState {
    return agentLifecycleRunState(agents.lifecycle(id), agents.question(id) !== null);
  }

  function isActive(id: string): boolean {
    return active === id;
  }

  function open(mode: Mode, id: string, kind: string, resourceId: string, title: string): void {
    openTab(mode, { id, kind, resourceId, title });
  }
</script>

<aside class="sidebar" data-testid="sidebar" aria-label={`${modeLabel} sidebar`}>
  <div class="sidebar__body">
    {#if layout.mode === "goal"}
      <section class="sidebar-group" aria-label="Plan">
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("goal-document")}
          data-command="goal.document.open"
          onclick={() =>
            open("goal", "goal-document", "goal-document", "goal-document", "Goal document")}
        >
          <span class="sidebar-item__label">Goal document</span>
        </Button>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("adrs")}
          data-command="goal.adrs.open"
          data-testid="open-adrs"
          onclick={() => open("goal", "adrs", "adrs", "adrs", "ADRs")}
        >
          <span class="sidebar-item__label">ADRs</span>
          <span class="sidebar-item__meta">{goal.pendingCount} pending</span>
        </Button>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("skills")}
          data-command="goal.skills.open"
          data-testid="goal-skills-open"
          data-run-state={goal.skillsPrepActive ? "running" : "idle"}
          onclick={() => open("goal", "skills", "skills", "skills", "Skills")}
        >
          <span class="sidebar-item__label">Skills</span>
          <span class="sidebar-item__meta">{goal.skills.length}</span>
          {#if goal.skillsPrepActive}
            <span class="badge" data-tone={runStateTone("running")} data-testid="run-state-badge">
              running
            </span>
          {/if}
        </Button>
      </section>

      <section class="sidebar-group" aria-label="Run">
        <div class="sidebar-group__title">Run</div>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("overview")}
          data-command="open.goal.overview"
          data-testid="open-implementation"
          data-run-state={implementationRun()}
          onclick={() => open("goal", "overview", "overview", "overview", "Implementation")}
        >
          <span class="sidebar-item__label">Implementation</span>
          <span class="sidebar-item__meta">{goal.lifecycleActive ? stageWord : goal.running ? "manual" : "idle"}</span>
          {#if implementationRun() !== "idle"}
            <span
              class="badge"
              data-tone={runStateTone(implementationRun())}
              data-testid="run-state-badge"
            >
              {implementationRun()}
            </span>
          {/if}
        </Button>
      </section>

      {#if goal.pendingCount > 0}
      <section class="sidebar-group" aria-label="ADR records" data-testid="sidebar-records">
        <div class="sidebar-group__title">
          <span>ADR records</span>
          <span>{resolvedCount}/{goal.records.length}</span>
        </div>
        <div
          class="sidebar-progress"
          role="progressbar"
          aria-label="Resolved decision records"
          aria-valuemin="0"
          aria-valuemax={goal.records.length}
          aria-valuenow={resolvedCount}
        >
          <span style={`width: ${progressPercent}%`}></span>
        </div>
        {#if goal.records.length === 0}
          <p class="sidebar-empty">No records yet.</p>
        {:else}
          {#each pendingRecords as entry (entry.file)}
            <Button
              bare
              class="sidebar-item"
              aria-current={isActive(`adr:${entry.file}`)}
              data-command={`goal.adr.open.${entry.file}`}
              data-testid="sidebar-adr"
              data-file={entry.file}
              data-pending="true"
              title={`${entry.title} — ${entry.status || "Unknown"}`}
              onclick={() => open("goal", `adr:${entry.file}`, "adr", entry.file, entry.title)}
            >
              <span class="sidebar-item__label">{entry.title}</span>
              {#if goal.next === entry.file}
                <span class="badge" data-tone="accent">Next</span>
              {:else}
                <span class="sidebar-item__meta">{entry.status || "Unknown"}</span>
              {/if}
            </Button>
          {/each}
          <Button
            bare
            class="sidebar-item"
            data-command="goal.adrs.open"
            data-testid="sidebar-all-records"
            onclick={() => open("goal", "adrs", "adrs", "adrs", "ADRs")}
          >
            <span class="sidebar-item__label">All records</span>
            <span class="sidebar-item__meta">{goal.records.length}</span>
          </Button>
        {/if}
      </section>
      {/if}

      <section class="sidebar-group" aria-label="Lanes" data-testid="lane-tabs">
        <div class="sidebar-group__title">
          <span>Lanes</span>
          {#if goal.lanes.length > 0}
            <span>{goal.runningLanes} running · {goal.lanes.length}</span>
          {/if}
        </div>
        <div role="tablist" aria-label="Agent lanes">
          {#each goal.lanes as lane (lane.id)}
            {@const label = goal.laneLabel(lane)}
            <Button
              bare
              class="sidebar-item"
              role="tab"
              aria-selected={isActive(`lane:${lane.id}`)}
              aria-label={`${label} (${lane.status})`}
              data-testid="lane-tab"
              data-lane={lane.id}
              data-kind={lane.kind}
              data-epic={lane.epic === null ? undefined : String(lane.epic.number)}
              data-record={lane.record?.file}
              data-attempt={lane.attempt}
              data-status={lane.status}
              data-command={`goal.lane.open.${lane.id}`}
              onclick={() => open("goal", `lane:${lane.id}`, "lane", lane.id, label)}
            >
              <span class="sidebar-item__label">{label}</span>
              <span class="badge" data-tone={statusTone(lane.status)}>
                {lane.status}
              </span>
            </Button>
          {/each}
        </div>
        {#if goal.lanes.length === 0}
          <p class="sidebar-empty">No lanes yet.</p>
        {/if}
      </section>

    {:else if layout.mode === "issues"}
      <section class="sidebar-group" aria-label="Issues surfaces">
        <div class="sidebar-group__title">Issues surfaces</div>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("overview")}
          data-command="open.issues.overview"
          data-testid="open-issues-overview"
          data-run-state={issuesOverviewRun()}
          onclick={() => open("issues", "overview", "overview", "overview", "Overview")}
        >
          <span class="sidebar-item__label">Overview</span>
          <span class="badge" data-tone={statusTone(issues.lifecycle)}>
            {issues.lifecycle}
          </span>
          {#if issuesOverviewRun() === "answer"}
            <span class="badge" data-tone={runStateTone("answer")} data-testid="run-state-badge">
              answer
            </span>
          {/if}
        </Button>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("issues")}
          data-command="open.issues.issues"
          data-testid="open-issues-queue"
          onclick={() => open("issues", "issues", "queue", "issues", "Issues")}
        >
          <span class="sidebar-item__label">Issues</span>
          <span class="sidebar-item__meta">{queueSummary(issueQueue)}</span>
        </Button>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("drafts")}
          aria-label="Draft goals, Issues mode, Alt+2"
          data-command="open.issues.drafts"
          data-testid="open-issues-drafts"
          data-run-state={draftsRun()}
          onclick={() => open("issues", "drafts", "drafts", "drafts", "Draft goals")}
        >
          <span class="sidebar-item__label">Draft goals</span>
          <span class="sidebar-item__meta">{goalDrafts.drafts.length}</span>
          {#if draftsRun() !== "idle"}
            <span class="badge" data-tone={runStateTone(draftsRun())} data-testid="run-state-badge">
              {draftsRun()}
            </span>
          {/if}
        </Button>
      </section>
    {:else if layout.mode === "flow"}
      <section class="sidebar-group" aria-label="Flow surfaces">
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("overview")}
          data-command="open.flow.overview"
          data-run-state={flowRun()}
          onclick={() => open("flow", "overview", "overview", "overview", "Overview")}
        >
          <span class="sidebar-item__label">Overview</span>
          {#if flow.status !== "none"}
            <span class="badge" data-tone={statusTone(flow.status)}>
              {flow.status}
            </span>
          {/if}
          {#if flowRun() === "answer"}
            <span class="badge" data-tone={runStateTone("answer")} data-testid="run-state-badge">
              answer
            </span>
          {/if}
        </Button>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("decisions")}
          data-command="open.flow.decisions"
          onclick={() => open("flow", "decisions", "decisions", "decisions", "Decision board")}
        >
          <span class="sidebar-item__label">Decision board</span>
        </Button>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("steering")}
          data-command="open.flow.steering"
          onclick={() => open("flow", "steering", "steering", "steering", "Steering")}
        >
          <span class="sidebar-item__label">Steering</span>
          <span class="sidebar-item__meta">{flow.steering.length}</span>
        </Button>
        <Button
          bare
          class="sidebar-item"
          aria-current={isActive("history")}
          data-command="open.flow.history"
          onclick={() => open("flow", "history", "history", "history", "History")}
        >
          <span class="sidebar-item__label">History</span>
          <span class="sidebar-item__meta">{flow.history.length}</span>
        </Button>
      </section>

      <section class="sidebar-group" aria-label="Session">
        <div class="sidebar-group__title">Session</div>
        <Button
          bare
          class="sidebar-item"
          data-command="open.flow.overview"
          data-run-state={flowRun()}
          onclick={() => open("flow", "overview", "overview", "overview", "Overview")}
        >
          <span class="sidebar-item__label">Status</span>
          {#if flow.status !== "none"}
            <span class="badge" data-tone={statusTone(flow.status)}>
              {flow.status}
            </span>
          {/if}
          {#if flowRun() === "answer"}
            <span class="badge" data-tone={runStateTone("answer")} data-testid="run-state-badge">
              answer
            </span>
          {/if}
        </Button>
        {#if flow.branch !== null}
          <div class="sidebar-item__meta" style="padding: 0 6px 4px;">branch {flow.branch}</div>
        {/if}
        {#if flow.pr !== null}
          <Button
            bare
            class="sidebar-item"
            data-command="open.flow.overview"
            title={flow.pr.url}
            onclick={() => open("flow", "overview", "overview", "overview", "Overview")}
          >
            <span class="sidebar-item__label">Pull request</span>
            <span class="badge" data-tone={flow.pr.state === "merged" ? "success" : "accent"}>
              #{flow.pr.number} {flow.pr.state}
            </span>
          </Button>
        {:else}
          <div class="sidebar-item__meta" style="padding: 0 6px 4px;">no pull request</div>
        {/if}
      </section>

      <section class="sidebar-group" aria-label="Change widgets">
        <div class="sidebar-group__title">
          <span>Widgets</span>
          <span>{flow.widgets.length}</span>
        </div>
        {#each flow.widgets as widget (widget.id)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(`widget:${widget.id}`)}
            data-command={`flow.widget.open.${widget.id}`}
            data-widget-id={widget.id}
            data-category={widget.category}
            data-accepted={widget.accepted ? "true" : "false"}
            title={`${widget.category} · ${widget.summary}`}
            onclick={() =>
              open("flow", `widget:${widget.id}`, "widget", widget.id, widget.concept)}
          >
            <span class="sidebar-item__label">{widget.concept}</span>
            <span class="badge" data-tone={widget.accepted ? "success" : "warning"}>
              {widget.accepted ? "accepted" : "open"}
            </span>
          </Button>
        {:else}
          <p class="sidebar-empty">No widgets yet.</p>
        {/each}
      </section>

      <section class="sidebar-group" aria-label="Changed files">
        <div class="sidebar-group__title">
          <span>Changed files</span>
          <span>{flow.files.length}</span>
        </div>
        {#each flow.files as file (file.path)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(`file:${file.path}`)}
            data-command={`flow.file.open.${file.path}`}
            title={file.path}
            onclick={() =>
              open("flow", `file:${file.path}`, "file", file.path, file.path.split("/").pop() ?? file.path)}
          >
            <span class="sidebar-item__label mono">{file.path}</span>
            <span class="badge" data-tone={file.status === "deleted" ? "error" : "accent"}>
              {file.status}
            </span>
          </Button>
        {:else}
          <p class="sidebar-empty">No changed files.</p>
        {/each}
      </section>

      <section class="sidebar-group" aria-label="Checkpoints">
        <div class="sidebar-group__title">
          <span>Checkpoints</span>
          <span>{flow.checkpoints.length}</span>
        </div>
        {#each flow.checkpoints as checkpoint (checkpoint.id)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(`checkpoint:${checkpoint.id}`)}
            data-command={`flow.checkpoint.open.${checkpoint.id}`}
            title={checkpoint.summary}
            onclick={() =>
              open(
                "flow",
                `checkpoint:${checkpoint.id}`,
                "checkpoint",
                checkpoint.id,
                checkpoint.summary,
              )}
          >
            <span class="sidebar-item__label">{checkpoint.summary}</span>
            <span class="badge" data-tone={verificationTone(checkpoint.verification)}>
              {checkpoint.verification}
            </span>
          </Button>
        {:else}
          <p class="sidebar-empty">No checkpoints.</p>
        {/each}
      </section>

      <section class="sidebar-group" aria-label="Blockers">
        <div class="sidebar-group__title">
          <span>Blockers</span>
          <span>{flow.blockers.filter((blocker) => !blocker.dismissed).length} open</span>
        </div>
        {#each flow.blockers as blocker (blocker.id)}
          <Button
            bare
            class="sidebar-item"
            data-command={`flow.blocker.open.${blocker.id}`}
            data-dismissed={blocker.dismissed ? "true" : "false"}
            title={blocker.text}
            onclick={() => {
              open("flow", "overview", "overview", "overview", "Overview");
              void focusLater?.("flow", `#flow-blocker-${blocker.id}`);
            }}
          >
            <span class="sidebar-item__label">{blocker.text}</span>
            <span class="badge" data-tone={blocker.dismissed ? "success" : "error"}>
              {blocker.dismissed ? "dismissed" : "open"}
            </span>
          </Button>
        {:else}
          <p class="sidebar-empty">No blockers.</p>
        {/each}
      </section>
    {:else if layout.mode === "discover"}
      <section class="sidebar-group" aria-label="Discover sections">
        {#each SECTION_TABS as tab (tab.id)}
          {@const runState = tabRun(tab)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(tab.id)}
            data-testid="discover-tab"
            data-tab={tab.id}
            data-run-state={runState}
            data-command={`discover.tab.${tab.id}`}
            onclick={() => open("discover", tab.id, tab.id, tab.id, tab.label)}
          >
            <span class="sidebar-item__label">{tab.label}</span>
            {#if runState !== "idle"}
              <span
                class="badge"
                data-tone={runStateTone(runState)}
                data-testid={tab.id === "overview" ? "discover-running" : "run-state-badge"}
              >
                {runState}
              </span>
            {/if}
            {#if tab.id === "glossary"}
              <span class="sidebar-item__meta">
                {termCount} {termCount === 1 ? "term" : "terms"}
              </span>
            {/if}
          </Button>
        {/each}
      </section>

      <section
        class="sidebar-group"
        aria-label="Discovery"
        data-testid="discover-agents"
      >
        <div class="sidebar-group__title">
          <span>Discovery</span>
        </div>
        {#each DISCOVER_AGENTS as agent (agent.id)}
          {@const status = discover.agent(agent.id)?.state ?? "idle"}
          {@const runState = agentRun(agent.id)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(agent.id)}
            data-testid="discover-agent-tab"
            data-agent={agent.id}
            data-state={status}
            data-run-state={runState}
            data-command={`discover.agent.${agent.id}`}
            title={`${agent.command} — ${status}`}
            onclick={() => open("discover", agent.id, "agent", agent.id, agent.label)}
          >
            <span class="sidebar-item__label">{agent.label}</span>
            {#if runState !== "idle"}
              <span
                class="badge"
                data-tone={runStateTone(runState)}
                data-testid={runState === "running" ? "discover-agent-running" : "run-state-badge"}
              >
                {runState}
              </span>
            {/if}
          </Button>
        {/each}
      </section>

      {#if discover.hasArtifacts}
      <section class="sidebar-group" aria-label="Skills">
        <div class="sidebar-group__title">
          <span>Skills</span>
        </div>
        {#each SKILL_TABS as tab (tab.id)}
          {@const state = tab.skill === null ? "generated" : skillState(tab.skill)}
          {@const runState = tabRun(tab)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(tab.id)}
            data-testid="discover-tab"
            data-tab={tab.id}
            data-skill={tab.skill ?? undefined}
            data-state={state}
            data-run-state={runState}
            data-command={`discover.tab.${tab.id}`}
            onclick={() => open("discover", tab.id, "skill", tab.skill ?? tab.id, tab.label)}
          >
            <span class="sidebar-item__label">{tab.label}</span>
            {#if state !== "generated"}
              <span class="sidebar-item__meta" data-tone={state === "missing" ? "error" : "warning"}>
                {state}
              </span>
            {/if}
            {#if runState !== "idle"}
              <span class="badge" data-tone={runStateTone(runState)} data-testid="run-state-badge">
                {runState}
              </span>
            {/if}
          </Button>
        {/each}
      </section>
      {/if}

      {#if discover.displayedWarnings.length > 0}
        <section class="sidebar-group sidebar-group--separated" aria-label="Warnings">
          <div class="sidebar-group__title">
            <span>Warnings</span>
            <span>{discover.displayedWarnings.length}</span>
          </div>
          <Button
            bare
            class="sidebar-item"
            data-command="open.discover.warnings"
            onclick={() => open("discover", "warnings", "warnings", "warnings", "Warnings")}
          >
            <span class="sidebar-item__label">Review warnings</span>
          </Button>
        </section>
      {/if}
    {:else}
      <section
        class="sidebar-group"
        aria-label="Background agents"
        data-testid="sidebar-background-agents"
      >
        <div class="sidebar-group__title">Background agents</div>
        {#each agents.descriptors as descriptor (descriptor.id)}
          {@const snapshot = agents.snapshot(descriptor.id)}
          {@const runState = agentRunState(descriptor.id)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(descriptor.tab.id) ? "true" : undefined}
            aria-label={`${descriptor.label} (${modeLabel})`}
            data-command={`open.devboard.${descriptor.id}`}
            data-testid={`open-devboard-${descriptor.id}`}
            data-run-state={runState}
            onclick={() =>
              open(
                "devboard",
                descriptor.tab.id,
                descriptor.tab.kind,
                descriptor.tab.id,
                descriptor.tab.title,
              )}
          >
            <span class="sidebar-item__label">{descriptor.label}</span>
            <span
              class="badge"
              data-tone={statusTone(snapshot?.lifecycle ?? "stopped")}
              data-testid={`agent-state-${descriptor.id}`}
              data-state={snapshot?.lifecycle ?? "stopped"}
              data-run-state={runState}
            >
              {snapshot?.lifecycle ?? "stopped"}
            </span>
            {#if runState === "answer"}
              <span class="badge" data-tone={runStateTone("answer")} data-testid="run-state-badge">
                answer
              </span>
            {/if}
            <span class="sidebar-item__meta" data-testid={`agent-count-${descriptor.id}`}>
              {agents.count(descriptor.id)}
            </span>
          </Button>
        {/each}
      </section>

      <section class="sidebar-group" aria-label="Devboard sections">
        {#each DEVBOARD_SIDEBAR as entry (entry.id)}
          <Button
            bare
            class="sidebar-item"
            aria-current={isActive(entry.tab.id)}
            data-testid="devboard-tab"
            data-command={entry.command}
            onclick={() =>
              open("devboard", entry.tab.id, entry.tab.kind, entry.tab.resourceId, entry.tab.title)}
          >
            <span class="sidebar-item__label">{entry.label}</span>
          </Button>
        {/each}
      </section>
    {/if}
  </div>
</aside>
