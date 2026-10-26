<script lang="ts">
  import ChevronRight from "lucide-svelte/icons/chevron-right";
  import {
    conceptTitle,
    contextTitle,
    SECTION_TABS,
    SKILL_TABS,
  } from "../discover-format";
  import { discover } from "../discover.svelte";
  import { flow } from "../flow.svelte";
  import { goal } from "../goal.svelte";
  import { layout } from "../layout.svelte";
  import { notifications } from "../notifications.svelte";
  import type { WorkspaceTab } from "../layout.svelte";
  import type { Mode } from "../types";

  interface Props {
    openTab: (mode: Mode, tab: WorkspaceTab) => void;
  }

  let { openTab }: Props = $props();

  const active = $derived(layout.activeTab[layout.mode]);
  let glossaryOpen = $state<boolean | null>(null);
  let skillsOpen = $state(false);
  const glossaryVisible = $derived(
    glossaryOpen ??
      (typeof active === "string" && (active === "glossary" || active.startsWith("term:"))),
  );
  const modeLabel = $derived(
    layout.mode === "goal" ? "Goal" : layout.mode === "flow" ? "Flow" : "Discover",
  );

  function isActive(id: string): boolean {
    return active === id;
  }

  function open(mode: Mode, id: string, kind: string, resourceId: string, title: string): void {
    openTab(mode, { id, kind, resourceId, title });
  }
</script>

<aside class="sidebar" data-testid="sidebar" aria-label={`${modeLabel} sidebar`}>
  <div class="sidebar__header">
    <span class="sidebar__title">{modeLabel}</span>
  </div>

  <div class="sidebar__body">
    {#if layout.mode === "goal"}
      <section class="sidebar-group" aria-label="Goal surfaces">
        <div class="sidebar-group__title">Workspace</div>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("overview")}
          data-command="open.goal.overview"
          onclick={() => open("goal", "overview", "overview", "overview", "Overview")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">Overview</span>
        </button>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("adrs")}
          data-command="goal.adrs.open"
          data-testid="open-adrs"
          onclick={() => open("goal", "adrs", "adrs", "adrs", "ADRs")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">ADRs</span>
          <span class="sidebar-item__meta">{goal.records.length}</span>
        </button>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("goal-document")}
          data-command="goal.document.open"
          onclick={() =>
            open("goal", "goal-document", "goal-document", "goal-document", "Goal document")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">Goal document</span>
          {#if goal.goalDirty}
            <span class="badge" data-tone="warning">unsaved</span>
          {/if}
        </button>
        <div class="sidebar-tab-row">
          <button
            type="button"
            class="sidebar-item"
            aria-current={isActive("skills")}
            aria-expanded={skillsOpen}
            aria-controls={skillsOpen ? "goal-skills-menu" : undefined}
            data-command="goal.skills.open"
            data-testid="goal-skills-toggle"
            onclick={() => {
              skillsOpen = !skillsOpen;
              open("goal", "skills", "skills", "skills", "Skills");
            }}
          >
            <span class="sidebar-item__label">Skills</span>
            <span class="sidebar-item__meta">{goal.skills.length}</span>
          </button>
          <button
            type="button"
            class="sidebar-disclosure"
            aria-expanded={skillsOpen}
            aria-controls={skillsOpen ? "goal-skills-menu" : undefined}
            aria-label={`${skillsOpen ? "Hide" : "Show"} prepared skills`}
            data-testid="goal-skills-disclosure"
            onclick={() => (skillsOpen = !skillsOpen)}
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              class={skillsOpen
                ? "sidebar-disclosure__icon sidebar-disclosure__icon--open"
                : "sidebar-disclosure__icon"}
            />
          </button>
        </div>
        {#if skillsOpen}
          <div
            class="sidebar-submenu"
            id="goal-skills-menu"
            data-testid="goal-skills-menu"
            role="group"
            aria-label="Prepared skills"
          >
            {#each goal.skills as skill (skill.name)}
              <button
                type="button"
                class="sidebar-item sidebar-item--nested"
                data-command={`goal.skill.open.${skill.name}`}
                data-testid="goal-skill"
                data-name={skill.name}
                title={skill.description}
                onclick={() => {
                  goal.selectSkill(skill.name);
                  open("goal", "skills", "skills", "skills", "Skills");
                }}
              >
                <span class="sidebar-item__label">{skill.name}</span>
              </button>
            {:else}
              <p class="sidebar-empty">No skills prepared.</p>
            {/each}
          </div>
        {/if}
      </section>

      {#if goal.pendingCount > 0}
        <section class="sidebar-group" aria-label="ADR records">
          <div class="sidebar-group__title">
            <span>ADR records</span>
            <span>{goal.pendingCount} pending</span>
          </div>
          {#each goal.records as record (record.file)}
            <button
              type="button"
              class="sidebar-item"
              aria-current={isActive(`adr:${record.file}`)}
              data-command={`goal.adr.open.${record.file}`}
              data-testid="sidebar-adr"
              data-file={record.file}
              data-pending={record.pending}
              data-next={goal.next === record.file}
              title={`${record.title} — ${record.status || "Unknown"}`}
              onclick={() =>
                open("goal", `adr:${record.file}`, "adr", record.file, record.title)}
            >
              <span class="sidebar-item__label">{record.title}</span>
              {#if goal.next === record.file}
                <span class="badge" data-tone="accent" data-testid="next-marker-badge">Next</span>
              {:else}
                <span class="badge" data-tone={record.pending ? "pending" : "resolved"}>
                  {record.pending ? "Pending" : "Resolved"}
                </span>
              {/if}
            </button>
            <div class="sidebar-item__meta" style="padding: 0 6px 4px 24px;">
              {record.file} · {record.status || "Unknown"}
            </div>
          {/each}
        </section>
      {/if}

      <section class="sidebar-group" aria-label="Lifecycle lanes" data-testid="lane-tabs">
        <div class="sidebar-group__title">
          <span>Lanes</span>
          <span>{goal.runningLanes} running</span>
        </div>
        <div role="tablist" aria-label="Agent lanes">
          {#each goal.lanes as lane (lane.id)}
            {@const label = goal.laneLabel(lane)}
            <button
              type="button"
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
              <span class="badge" data-tone={lane.status === "running" ? "accent" : "warning"}>
                {lane.status}
              </span>
            </button>
          {/each}
        </div>
        {#if goal.lanes.length === 0}
          <p class="sidebar-empty">No lanes yet.</p>
        {/if}
      </section>

    {:else if layout.mode === "flow"}
      <section class="sidebar-group" aria-label="Flow surfaces">
        <div class="sidebar-group__title">Workspace</div>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("overview")}
          data-command="open.flow.overview"
          onclick={() => open("flow", "overview", "overview", "overview", "Overview")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">Overview</span>
          <span class="badge" data-tone={flow.status === "running" ? "accent" : "warning"}>
            {flow.status}
          </span>
        </button>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("flow-goal")}
          data-command="open.flow.flow-goal"
          onclick={() => open("flow", "flow-goal", "flow-goal", "flow-goal", "Flow goal")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">Flow goal</span>
          {#if flow.goalDirty}
            <span class="badge" data-tone="warning">unsaved</span>
          {/if}
        </button>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("decisions")}
          data-command="open.flow.decisions"
          onclick={() => open("flow", "decisions", "decisions", "decisions", "Decision board")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">Decision board</span>
          {#if flow.decisionsDirty}
            <span class="badge" data-tone="warning">unsaved</span>
          {/if}
        </button>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("steering")}
          data-command="open.flow.steering"
          onclick={() => open("flow", "steering", "steering", "steering", "Steering")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">Steering</span>
          <span class="sidebar-item__meta">{flow.steering.length}</span>
        </button>
        <button
          type="button"
          class="sidebar-item"
          aria-current={isActive("history")}
          data-command="open.flow.history"
          onclick={() => open("flow", "history", "history", "history", "History")}
        >
          <ChevronRight size={12} aria-hidden="true" />
          <span class="sidebar-item__label">History</span>
          <span class="sidebar-item__meta">{flow.history.length}</span>
        </button>
      </section>

      <section class="sidebar-group" aria-label="Session">
        <div class="sidebar-group__title">Session</div>
        <button
          type="button"
          class="sidebar-item"
          data-command="open.flow.overview"
          onclick={() => open("flow", "overview", "overview", "overview", "Overview")}
        >
          <span class="sidebar-item__label">Status</span>
          <span class="badge" data-tone={flow.status === "running" ? "accent" : "warning"}>
            {flow.status}
          </span>
        </button>
        {#if flow.branch !== null}
          <div class="sidebar-item__meta" style="padding: 0 6px 4px;">branch {flow.branch}</div>
        {/if}
        {#if flow.pr !== null}
          <button
            type="button"
            class="sidebar-item"
            data-command="open.flow.overview"
            title={flow.pr.url}
            onclick={() => open("flow", "overview", "overview", "overview", "Overview")}
          >
            <span class="sidebar-item__label">Pull request</span>
            <span class="badge" data-tone={flow.pr.state === "merged" ? "success" : "accent"}>
              #{flow.pr.number} {flow.pr.state}
            </span>
          </button>
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
          <button
            type="button"
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
          </button>
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
          <button
            type="button"
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
          </button>
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
          <button
            type="button"
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
            <span class="badge" data-tone={checkpoint.verification === "failed" ? "error" : "success"}>
              {checkpoint.verification}
            </span>
          </button>
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
          <button
            type="button"
            class="sidebar-item"
            data-command={`flow.blocker.open.${blocker.id}`}
            data-dismissed={blocker.dismissed ? "true" : "false"}
            title={blocker.text}
            onclick={() => open("flow", "overview", "overview", "overview", "Overview")}
          >
            <span class="sidebar-item__label">{blocker.text}</span>
            <span class="badge" data-tone={blocker.dismissed ? "success" : "error"}>
              {blocker.dismissed ? "dismissed" : "open"}
            </span>
          </button>
        {:else}
          <p class="sidebar-empty">No blockers.</p>
        {/each}
      </section>
    {:else}
      <section class="sidebar-group" aria-label="Discover sections">
        <div class="sidebar-group__title">Sections</div>
        {#each SECTION_TABS as tab (tab.id)}
          {#if tab.id === "glossary"}
            <div class="sidebar-tab-row">
              <button
                type="button"
                class="sidebar-item"
                aria-current={isActive(tab.id)}
                role="tab"
                aria-selected={isActive(tab.id)}
                data-testid="discover-tab"
                data-tab={tab.id}
                data-command={`discover.tab.${tab.id}`}
                onclick={() => open("discover", tab.id, tab.id, tab.id, tab.label)}
              >
                <span class="sidebar-item__label">{tab.label}</span>
              </button>
              <button
                type="button"
                class="sidebar-disclosure"
                aria-expanded={glossaryVisible}
                aria-controls={glossaryVisible ? "discover-glossary-menu" : undefined}
                aria-label={`${glossaryVisible ? "Hide" : "Show"} glossary contexts`}
                data-testid="discover-glossary-toggle"
                onclick={() => (glossaryOpen = !glossaryVisible)}
              >
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  class={glossaryVisible
                    ? "sidebar-disclosure__icon sidebar-disclosure__icon--open"
                    : "sidebar-disclosure__icon"}
                />
              </button>
            </div>
            {#if glossaryVisible}
              <div
                class="sidebar-submenu"
                id="discover-glossary-menu"
                data-testid="discover-glossary-menu"
                role="group"
                aria-label="Glossary contexts"
              >
                {#each discover.contexts as context (context.boundedContext)}
                  <div class="sidebar-submenu__context">{contextTitle(context)}</div>
                  {#each context.concepts.filter((concept) => concept.status !== "invalidated") as concept (concept.id)}
                    <button
                      type="button"
                      class="sidebar-item sidebar-item--nested"
                      aria-current={isActive(`term:${context.boundedContext}:${concept.id}`)}
                      data-command={`discover.term.open.${context.boundedContext}.${concept.id}`}
                      title={concept.id}
                      onclick={() =>
                        open(
                          "discover",
                          `term:${context.boundedContext}:${concept.id}`,
                          "term",
                          `${context.boundedContext}:${concept.id}`,
                          conceptTitle(concept),
                        )}
                    >
                      <span class="sidebar-item__label">{conceptTitle(concept)}</span>
                    </button>
                  {/each}
                {:else}
                  <p class="sidebar-empty">No glossary terms.</p>
                {/each}
              </div>
            {/if}
          {:else}
            <button
              type="button"
              class="sidebar-item"
              aria-current={isActive(tab.id)}
              role="tab"
              aria-selected={isActive(tab.id)}
              data-testid="discover-tab"
              data-tab={tab.id}
              data-command={`discover.tab.${tab.id}`}
              onclick={() => open("discover", tab.id, tab.id, tab.id, tab.label)}
            >
              <span class="sidebar-item__label">{tab.label}</span>
            </button>
          {/if}
        {/each}
      </section>

      <section class="sidebar-group" aria-label="Skills">
        <div class="sidebar-group__title">
          <span>Skills</span>
          <span>{SKILL_TABS.length}</span>
        </div>
        {#each SKILL_TABS as tab (tab.id)}
          <button
            type="button"
            class="sidebar-item"
            aria-current={isActive(tab.id)}
            role="tab"
            aria-selected={isActive(tab.id)}
            data-testid="discover-tab"
            data-tab={tab.id}
            data-skill={tab.skill ?? undefined}
            data-command={`discover.tab.${tab.id}`}
            onclick={() => open("discover", tab.id, "skill", tab.skill ?? tab.id, tab.label)}
          >
            <span class="sidebar-item__label">{tab.label}</span>
          </button>
        {/each}
      </section>

      {#if discover.displayedWarnings.length > 0}
        <section class="sidebar-group" aria-label="Warnings">
          <div class="sidebar-group__title">
            <span>Warnings</span>
            <span>{discover.displayedWarnings.length}</span>
          </div>
          {#each discover.displayedWarnings as warning, index (index)}
            <button
              type="button"
              class="sidebar-item"
              data-command="open.discover.warnings"
              onclick={() => open("discover", "warnings", "warnings", "warnings", "Warnings")}
            >
              <span class="sidebar-item__label">{warning}</span>
            </button>
          {/each}
        </section>
      {/if}

      {#if notifications.items.length > 0}
        <section class="sidebar-group" aria-label="Recent notifications">
          <div class="sidebar-group__title">Recent notices</div>
          {#each notifications.items.slice(0, 3) as item (item.id)}
            <div class="sidebar-item" style="cursor: default;">
              <span class="sidebar-item__label">{item.text}</span>
              <span class="badge" data-tone={item.severity === "error" ? "error" : "warning"}>
                {item.severity}
              </span>
            </div>
          {/each}
        </section>
      {/if}
    {/if}
  </div>
</aside>
