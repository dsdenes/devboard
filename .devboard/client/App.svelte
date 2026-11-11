<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Pane, PaneGroup } from "paneforge";
  import { Tooltip } from "bits-ui";
  import ActivityBar from "./lib/components/ActivityBar.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import CommandButton from "./lib/components/CommandButton.svelte";
  import DevboardWorkspace from "./lib/components/DevboardWorkspace.svelte";
  import DiscoverWorkspace from "./lib/components/DiscoverWorkspace.svelte";
  import FeedbackOverlay from "./FeedbackOverlay.svelte";
  import FlowMode from "./FlowMode.svelte";
  import GoalWorkspace from "./lib/components/GoalWorkspace.svelte";
  import IssuesWorkspace from "./lib/components/IssuesWorkspace.svelte";
  import NotificationRegion from "./lib/components/NotificationRegion.svelte";
  import PaneHandle from "./lib/components/PaneHandle.svelte";
  import PollScheduler from "./lib/components/PollScheduler.svelte";
  import ProvidersDialog from "./lib/components/ProvidersDialog.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import { buildCommands } from "./lib/commands";
  import { complexity } from "./lib/complexity.svelte";
  import { connection } from "./lib/connection.svelte";
  import { devboardSkills } from "./lib/devboard-skills.svelte";
  import { discover } from "./lib/discover.svelte";
  import { flow } from "./lib/flow.svelte";
  import { goal } from "./lib/goal.svelte";
  import { draftsPageWasOpen, goalDrafts } from "./lib/goal-drafts.svelte";
  import { issues } from "./lib/issues.svelte";
  import { agents } from "./lib/agents.svelte";
  import { applyTheme, layout } from "./lib/layout.svelte";
  import type { WorkspaceTab } from "./lib/layout.svelte";
  import { mcpTools } from "./lib/mcp-tools.svelte";
  import { notifications } from "./lib/notifications.svelte";
  import { fileSlowUiAction } from "./lib/notification-issue";
  import { collectPendingQuestions, osNotifications } from "./lib/os-notifications.svelte";
  import { providers } from "./lib/providers.svelte";
  import { resources } from "./lib/resources.svelte";
  import { slowUiAction, type SlowUiActionContext } from "./lib/slow-ui-action";
  import type { FeedbackAction, FeedbackPhase, Mode } from "./lib/types";
  import { MINIMUM_VIEWPORT, viewport } from "./lib/viewport.svelte";

  interface FeedbackHandle {
    startPicking: () => void;
    startRemoving: () => void;
    startRedesigning: () => void;
    toggleReport: () => void;
    toggleAction: (action: FeedbackAction) => void;
    cancelReport: () => void;
  }

  const MODES: Mode[] = ["goal", "issues", "flow", "discover", "devboard"];

  let paletteOpen = $state(false);
  let paletteReturnFocus: HTMLElement | null = null;
  let feedbackOverlay = $state<FeedbackHandle>();
  let reportPhase = $state<FeedbackPhase>("idle");
  let reportAction = $state<FeedbackAction | null>(null);

  const savedFocus: Record<Mode, HTMLElement | null> = {
    goal: null,
    issues: null,
    flow: null,
    discover: null,
    devboard: null,
  };

  let sidebarGroup = $state<{ setLayout: (sizes: number[]) => void }>();
  let sidebarSizes = $state<number[]>([]);

  // The panes share the group width minus the 5px `.pane-handle` between them.
  const SIDEBAR_HANDLE_WIDTH = 5;
  const availableWidth = $derived(Math.max(600, viewport.width - 72 - SIDEBAR_HANDLE_WIDTH));
  const sidebarMinPercent = $derived((200 / availableWidth) * 100);
  const sidebarMaxPercent = $derived((600 / availableWidth) * 100);
  const sidebarDefaultPercent = $derived((300 / availableWidth) * 100);
  const sidebarNow = $derived(((sidebarSizes[0] ?? sidebarDefaultPercent) / 100) * availableWidth);

  function workspaceTab(mode: Mode): WorkspaceTab | null {
    const id = layout.activeTab[mode];
    return id === null ? null : layout.tab(mode, id);
  }

  function openTab(mode: Mode, tab: WorkspaceTab): void {
    layout.setMode(mode);
    layout.openTab(mode, tab);
  }

  function focusModeAfterTick(mode: Mode): void {
    void tick().then(() => {
      document.getElementById(`mode-${mode}-tab`)?.focus();
    });
  }

  function performClose(mode: Mode, tab: WorkspaceTab): void {
    if (mode === "issues" && tab.kind === "agent") {
      layout.openTab("issues", {
        id: "agents",
        kind: "agents",
        resourceId: "agents",
        title: "Agents",
      });
    } else {
      layout.closeTab(mode, tab.id);
    }
    focusModeAfterTick(mode);
  }

  function closeTab(mode: Mode, tab: WorkspaceTab): void {
    performClose(mode, tab);
  }

  function resetLayout(): void {
    paletteOpen = false;
    notifications.closeHistory();
    layout.reset();
  }

  function reportIssue(): void {
    feedbackOverlay?.startPicking();
  }

  function removeElement(): void {
    feedbackOverlay?.startRemoving();
  }

  function redesignElement(): void {
    feedbackOverlay?.startRedesigning();
  }

  async function focusLater(mode: Mode, selector: string): Promise<void> {
    layout.setMode(mode);
    await tick();
    window.setTimeout(() => {
      const element = document.querySelector<HTMLElement>(selector);
      element?.focus();
    }, 0);
  }

  function rememberFocus(mode: Mode, event: FocusEvent): void {
    if (event.target instanceof HTMLElement) savedFocus[mode] = event.target;
  }

  function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.closest("input, textarea, select") !== null;
  }

  function openPalette(): void {
    if (paletteOpen) return;
    paletteReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    paletteOpen = true;
  }

  function closePalette(): void {
    if (!paletteOpen) return;
    paletteOpen = false;
    const previous = paletteReturnFocus;
    paletteReturnFocus = null;
    void tick().then(() => {
      if (previous !== null && previous.isConnected) previous.focus();
    });
  }

  function handleKeydown(event: KeyboardEvent): void {
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (command && key === "k") {
      event.preventDefault();
      if (paletteOpen) closePalette();
      else openPalette();
      return;
    }

    if (event.key === "Escape") {
      if (paletteOpen) {
        event.preventDefault();
        closePalette();
      }
      return;
    }

    if (paletteOpen || isTyping(event.target)) return;

    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const target =
        event.key === "1"
          ? "goal"
          : event.key === "2"
            ? "issues"
            : event.key === "3"
              ? "flow"
              : event.key === "4"
                ? "discover"
                : event.key === "5"
                  ? "devboard"
                  : null;
      if (target !== null) {
        event.preventDefault();
        layout.setMode(target);
      }
    }
  }

  /**
   * The page context one breached action carries into its issue. The element
   * the operator was using is the target; the body stands in when focus is
   * outside the document.
   */
  function captureSlowActionContext(): SlowUiActionContext {
    const active = document.activeElement;
    const target = active instanceof HTMLElement ? active : document.body;
    const selector =
      target === document.body || target.id.length === 0
        ? target.tagName.toLowerCase()
        : `#${target.id}`;
    return {
      route: window.location.pathname,
      url: window.location.href,
      selector,
      domExcerpt: (target.outerHTML ?? "").slice(0, 4000),
      visibleText: ((target as HTMLElement).innerText ?? target.textContent ?? "").slice(0, 1500),
      viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`,
      capturedAt: new Date().toISOString(),
    };
  }

  function handleFlowTabEvents(message: Record<string, unknown>): void {
    if (message.type === "flowConversationStarted" && typeof message.widgetId === "string") {
      const widget = flow.widget(message.widgetId);
      layout.openTab("flow", {
        id: `conversation:${message.widgetId}`,
        kind: "conversation",
        resourceId: message.widgetId,
        title: widget === null ? "Widget conversation" : `${widget.concept} conversation`,
      });
      return;
    }
    if (message.type === "flowConversationStopped" && typeof message.widgetId === "string") {
      const id = `conversation:${message.widgetId}`;
      if (layout.tab("flow", id) !== null) {
        layout.closeTab("flow", id);
        if (layout.mode === "flow") focusModeAfterTick("flow");
      }
    }
  }

  const commandsContext = {
    goal,
    flow,
    discover,
    issues,
    goalDrafts,
    layout,
    connection,
    notifications,
    openTab,
    closeTab: (mode: Mode, id: string) => {
      const tab = layout.tab(mode, id);
      if (tab !== null) closeTab(mode, tab);
    },
    focusLater,
    resetLayout,
    reportIssue,
    removeElement,
    redesignElement,
    cancelReport: () => feedbackOverlay?.cancelReport(),
  };

  const commands = $derived(buildCommands(commandsContext));

  let previousMode = layout.mode;
  let lastFlowConversation: string | null = null;

  $effect(() => {
    const mode = layout.mode;
    if (mode === previousMode) return;
    previousMode = mode;
    void tick().then(() => {
      const target = savedFocus[mode];
      if (target !== null && target.isConnected) target.focus({ preventScroll: true });
    });
  });

  $effect(() => {
    void layout.mode;
    void layout.theme;
    for (const mode of MODES) {
      for (const tab of layout.tabs[mode]) {
        void tab.id;
        void tab.title;
      }
      void layout.activeTab[mode];
    }
    layout.persist();
  });

  $effect(() => {
    const active = flow.conversation === null ? null : `conversation:${flow.conversation.widgetId}`;
    if (active === lastFlowConversation) return;
    lastFlowConversation = active;
    if (active !== null && flow.conversation !== null) {
      const widget = flow.widget(flow.conversation.widgetId);
      layout.openTab("flow", {
        id: active,
        kind: "conversation",
        resourceId: flow.conversation.widgetId,
        title: widget === null ? "Widget conversation" : `${widget.concept} conversation`,
      });
    }
  });

  onMount(() => {
    applyTheme(layout.theme);
    // A reload while the Drafts page is open restores that page even when the
    // layout snapshot is unavailable; its selected path is restored by the page.
    if (draftsPageWasOpen()) {
      layout.setMode("issues");
      layout.openTab("issues", {
        id: "drafts",
        kind: "drafts",
        resourceId: "drafts",
        title: "Draft goals",
      });
    }
    viewport.update();
    const onResize = () => viewport.update();
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", handleKeydown, true);

    connection.onOpen(() => {
      goal.resetActiveOperations();
      discover.resetActiveOperations();
      providers.resetActiveOperations();
      issues.resetActiveOperations();
      goalDrafts.resetActiveOperations();
    });
    connection.onMessage((message) => {
      const record = message as Record<string, unknown>;
      goal.handleEvent(record);
      issues.handleEvent(record);
      goalDrafts.handleEvent(record);
      agents.handleEvent(record);
      flow.handleEvent(record);
      discover.handleEvent(record);
      mcpTools.handleEvent(record);
      devboardSkills.handleEvent(record);
      complexity.handleEvent(record);
      resources.handleEvent(record);
      providers.handleEvent(record);
      handleFlowTabEvents(record);
      // The OS channel follows the same frames as the in-app state: every
      // snapshot, poll, and reconnect re-observes the whole pending set.
      osNotifications.observe(
        collectPendingQuestions({ goal, discover, flow, issues, goalDrafts }),
      );
    });
    slowUiAction.install({
      reportingEnabled: () => !connection.feedbackResolved || connection.feedbackEnabled,
      captureContext: captureSlowActionContext,
      show: (notice) => notifications.push("Performance", "notice", notice.text)?.id ?? 0,
      update: (id, issue) => notifications.setIssue(id, issue),
      file: (report, key) => fileSlowUiAction(report, key),
    });
    connection.connect();

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", handleKeydown, true);
      slowUiAction.reset();
      connection.dispose();
    };
  });
</script>

  {#snippet workspaceArea()}
    <div class="workspace-region" data-testid="workspace">
      <div class="workspace">
        {#each MODES as mode (mode)}
          <div
            class="mode-workspace"
            id={`workspace-${mode}`}
            role="tabpanel"
            aria-labelledby={`mode-${mode}-tab`}
            hidden={layout.mode !== mode}
            onfocusin={(event) => rememberFocus(mode, event)}
          >
            {#if mode === "goal"}
              <GoalWorkspace
                tab={workspaceTab("goal")}
                openTab={(tab) => openTab("goal", tab)}
                closeTab={(tab) => closeTab("goal", tab)}
              />
            {:else if mode === "issues"}
              <IssuesWorkspace
                tab={workspaceTab("issues")}
                openTab={(tab) => openTab("issues", tab)}
                closeTab={(tab) => closeTab("issues", tab)}
              />
            {:else if mode === "flow"}
              <FlowMode
                tab={workspaceTab("flow")}
                openTab={(tab) => openTab("flow", tab)}
                closeTab={(tab) => closeTab("flow", tab)}
              />
            {:else if mode === "discover"}
              <DiscoverWorkspace tab={workspaceTab("discover")} />
            {:else}
              <DevboardWorkspace tab={workspaceTab("devboard")} />
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/snippet}

<svelte:head>
  <title>{connection.projectPath.trim().length > 0 ? connection.projectPath : "Devboard"}</title>
</svelte:head>

{#if !viewport.supported}
  <div class="unsupported" data-testid="unsupported-viewport" role="alert">
    <h1>Viewport too small</h1>
    <p>
      Devboard needs at least {MINIMUM_VIEWPORT.width}×{MINIMUM_VIEWPORT.height} CSS pixels. The
      current viewport is {viewport.width}×{viewport.height}. Widen the window or connect a larger
      display.
    </p>
    {#if connection.version?.replacement != null}
      <CommandButton
        variant="default"
        label="Reload"
        evidence={() => connection.version?.running}
        command={() => connection.requestRestart()}
        data-command="app.reload"
        data-testid="reload-devboard"
        title={`Devboard ${connection.version.replacement.running ?? "unknown"} is still running; the automatic replacement with ${
          connection.version.replacement.installed ?? "unknown"
        } failed. Retry the replacement.`}
        aria-label={`Retry the devboard replacement from version ${
          connection.version.replacement.running ?? "unknown"
        } to version ${connection.version.replacement.installed ?? "unknown"}`}
        disabled={connection.restarting}
      >
        Restart devboard
      </CommandButton>
    {/if}
  </div>
{:else}
  <Tooltip.Provider>
    <div class="app-shell" data-testid="app-shell">
      <div class="shell-main">
        <ActivityBar
          onopenpalette={openPalette}
          onreportissue={() => feedbackOverlay?.toggleReport()}
          onremoveelement={() => feedbackOverlay?.toggleAction("REMOVE")}
          onredesignelement={() => feedbackOverlay?.toggleAction("REDESIGN")}
          reportphase={reportPhase}
          reportaction={reportAction}
          feedbackenabled={connection.feedbackEnabled}
        />
        <PaneGroup
          direction="horizontal"
          autoSaveId={`devboard.sidebar.${layout.epoch}`}
          bind:this={sidebarGroup}
          onLayoutChange={(sizes) => {
            if (sizes.length === 2) sidebarSizes = sizes;
          }}
          class="split-fill"
        >
          <Pane
            defaultSize={sidebarDefaultPercent}
            minSize={sidebarMinPercent}
            maxSize={sidebarMaxPercent}
            class="pane-fill"
          >
            <Sidebar openTab={openTab} focusLater={focusLater} />
          </Pane>
          <PaneHandle
            orientation="horizontal"
            minimum={200}
            maximum={600}
            current={sidebarNow}
            label="Sidebar width"
            ondblclick={() =>
              sidebarGroup?.setLayout([sidebarDefaultPercent, 100 - sidebarDefaultPercent])}
          />
          <Pane class="pane-fill">
            {@render workspaceArea()}
          </Pane>
        </PaneGroup>
      </div>
      <StatusBar />
    </div>
  </Tooltip.Provider>
{/if}

<CommandPalette open={paletteOpen} {commands} onclose={closePalette} />

<PollScheduler />

<Tooltip.Provider>
  <NotificationRegion feedbackenabled={connection.feedbackEnabled} />
</Tooltip.Provider>

<ProvidersDialog />

<FeedbackOverlay
  bind:this={feedbackOverlay}
  bind:phase={reportPhase}
  bind:action={reportAction}
/>
