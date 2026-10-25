<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Pane, PaneGroup } from "paneforge";
  import { Tooltip } from "bits-ui";
  import ActivityBar from "./lib/components/ActivityBar.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import ConfirmDialog from "./lib/components/ConfirmDialog.svelte";
  import DiscoverWorkspace from "./lib/components/DiscoverWorkspace.svelte";
  import FeedbackOverlay from "./FeedbackOverlay.svelte";
  import FlowMode from "./FlowMode.svelte";
  import GoalWorkspace from "./lib/components/GoalWorkspace.svelte";
  import NotificationRegion from "./lib/components/NotificationRegion.svelte";
  import PaneHandle from "./lib/components/PaneHandle.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import WorkspaceTabs from "./lib/components/WorkspaceTabs.svelte";
  import Button from "./lib/components/ui/button.svelte";
  import { buildCommands } from "./lib/commands";
  import { connection } from "./lib/connection.svelte";
  import { discover } from "./lib/discover.svelte";
  import { flow } from "./lib/flow.svelte";
  import { goal } from "./lib/goal.svelte";
  import { applyTheme, layout } from "./lib/layout.svelte";
  import type { WorkspaceTab } from "./lib/layout.svelte";
  import { notifications } from "./lib/notifications.svelte";
  import type { Mode } from "./lib/types";
  import { MINIMUM_VIEWPORT, viewport } from "./lib/viewport.svelte";

  interface PendingClose {
    mode: Mode;
    tab: WorkspaceTab;
  }

  interface FeedbackHandle {
    startPicking: () => void;
    cancelReport: () => void;
  }

  const MODES: Mode[] = ["goal", "flow", "discover"];

  let paletteOpen = $state(false);
  let paletteReturnFocus: HTMLElement | null = null;
  let pendingClose = $state<PendingClose | null>(null);
  let feedbackOverlay = $state<FeedbackHandle>();

  const savedFocus: Record<Mode, HTMLElement | null> = {
    goal: null,
    flow: null,
    discover: null,
  };

  let sidebarGroup = $state<{ setLayout: (sizes: number[]) => void }>();
  let sidebarSizes = $state<number[]>([]);

  const availableWidth = $derived(Math.max(600, viewport.width - 44));
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

  function tabDirty(mode: Mode, tab: WorkspaceTab): boolean {
    if (mode === "goal" && tab.kind === "goal-document") return goal.goalDirty;
    if (mode === "flow" && tab.kind === "flow-goal") return flow.goalDirty;
    if (mode === "flow" && tab.kind === "decisions") return flow.decisionsDirty;
    if (mode === "discover" && tab.kind === "skill") return discover.skillDirty(tab.resourceId);
    return false;
  }

  function focusTabAfterTick(mode: Mode, id: string | null): void {
    if (id === null) return;
    void tick().then(() => {
      document.getElementById(`workspace-tab-${id}`)?.focus();
      void mode;
    });
  }

  function performClose(mode: Mode, tab: WorkspaceTab): void {
    const next = layout.closeTab(mode, tab.id);
    focusTabAfterTick(mode, next);
  }

  function closeTab(mode: Mode, tab: WorkspaceTab): void {
    if (tabDirty(mode, tab)) {
      pendingClose = { mode, tab };
      return;
    }
    performClose(mode, tab);
  }

  function confirmDiscard(): void {
    if (pendingClose === null) return;
    const pending = pendingClose;
    pendingClose = null;
    if (pending.mode === "goal" && pending.tab.kind === "goal-document") goal.discardDraft();
    if (pending.mode === "flow" && pending.tab.kind === "flow-goal") flow.discardGoalDraft();
    if (pending.mode === "flow" && pending.tab.kind === "decisions") flow.discardDecisionsDraft();
    if (pending.mode === "discover" && pending.tab.kind === "skill") {
      discover.discardDraft(pending.tab.resourceId);
    }
    performClose(pending.mode, pending.tab);
  }

  function cancelDiscard(): void {
    pendingClose = null;
    focusTabAfterTick(layout.mode, layout.activeTab[layout.mode]);
  }

  function resetLayout(): void {
    paletteOpen = false;
    pendingClose = null;
    notifications.closeHistory();
    layout.reset();
  }

  function reportIssue(): void {
    feedbackOverlay?.startPicking();
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

  function focusedEditor(): EditorHandle | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return undefined;
    const host = active.closest<HTMLElement>("[data-monaco-editor]");
    if (host === null) return undefined;
    const id = host.dataset.monacoEditor;
    return id === undefined ? undefined : window.__devboardEditors?.get(id);
  }

  function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.closest("input, textarea, select, [contenteditable='true'], .monaco-editor") !== null;
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
      } else if (pendingClose !== null) {
        event.preventDefault();
        cancelDiscard();
      }
      return;
    }

    if (command && key === "s") {
      const handle = focusedEditor();
      if (handle !== undefined) {
        event.preventDefault();
        if (handle.isDirty()) handle.save();
      }
      return;
    }

    if (paletteOpen || isTyping(event.target)) return;

    if (command && key === "b") {
      event.preventDefault();
      layout.toggleSidebar();
      return;
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      const target = event.key === "1" ? "goal" : event.key === "2" ? "flow" : event.key === "3" ? "discover" : null;
      if (target !== null) {
        event.preventDefault();
        layout.setMode(target);
      }
    }
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
        const next = layout.closeTab("flow", id);
        if (layout.mode === "flow") focusTabAfterTick("flow", next);
      }
    }
  }

  const commandsContext = {
    goal,
    flow,
    discover,
    layout,
    connection,
    notifications,
    openTab,
    activateTab: (mode: Mode, id: string) => {
      layout.setMode(mode);
      layout.activateTab(mode, id);
    },
    closeTab: (mode: Mode, id: string) => {
      const tab = layout.tab(mode, id);
      if (tab !== null) closeTab(mode, tab);
    },
    focusLater,
    resetLayout,
    reportIssue,
    cancelReport: () => feedbackOverlay?.cancelReport(),
    canCloseTab: () => pendingClose !== null,
    confirmCloseTab: () => confirmDiscard(),
    cancelCloseTab: () => cancelDiscard(),
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
    void layout.sidebarVisible;
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
    viewport.update();
    const onResize = () => viewport.update();
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", handleKeydown, true);

    connection.onMessage((message) => {
      const record = message as Record<string, unknown>;
      goal.handleEvent(record);
      flow.handleEvent(record);
      discover.handleEvent(record);
      handleFlowTabEvents(record);
    });
    connection.connect();
    connection.startPolling();

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", handleKeydown, true);
      connection.dispose();
    };
  });
</script>

  {#snippet workspaceArea()}
    <div class="workspace-region" data-testid="workspace">
      <WorkspaceTabs
        dirty={(tab) => tabDirty(layout.mode, tab)}
        onactivate={(tab) => layout.activateTab(layout.mode, tab.id)}
        onclose={(tab) => closeTab(layout.mode, tab)}
      />
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
            {:else if mode === "flow"}
              <FlowMode
                tab={workspaceTab("flow")}
                openTab={(tab) => openTab("flow", tab)}
                closeTab={(tab) => closeTab("flow", tab)}
              />
            {:else}
              <DiscoverWorkspace
                tab={workspaceTab("discover")}
                openTab={(tab) => openTab("discover", tab)}
                closeTab={(tab) => closeTab("discover", tab)}
              />
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
    {#if connection.version?.stale === true}
      <Button
        variant="default"
        data-command="app.reload"
        data-testid="reload-devboard"
        title={`Devboard ${connection.version?.running ?? "unknown"} is running; ${
          connection.version?.installed ?? "unknown"
        } is installed. Restart the server and reload.`}
        aria-label={`Restart devboard, running ${connection.version?.running ?? "unknown"}, installed ${
          connection.version?.installed ?? "unknown"
        }`}
        disabled={connection.restarting}
        onclick={() => connection.requestRestart()}
      >
        Restart devboard
      </Button>
    {/if}
  </div>
{:else}
  <Tooltip.Provider>
    <div class="app-shell" data-testid="app-shell">
      <div class="shell-main">
        <ActivityBar />
        {#if layout.sidebarVisible}
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
              <Sidebar openTab={openTab} />
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
            <Pane minSize={40} class="pane-fill">
              {@render workspaceArea()}
            </Pane>
          </PaneGroup>
        {:else}
          {@render workspaceArea()}
        {/if}
      </div>
      <StatusBar onopenhistory={() => notifications.openHistory()} />
    </div>
  </Tooltip.Provider>
{/if}

<CommandPalette open={paletteOpen} {commands} onclose={closePalette} />

<ConfirmDialog
  open={pendingClose !== null}
  title="Unsaved changes"
  message={pendingClose === null ? "" : `Close “${pendingClose.tab.title}” and discard its unsaved changes?`}
  confirmLabel="Discard and close"
  destructive
  testid="confirm-close-tab"
  confirmCommand="tab.close.confirm"
  cancelCommand="tab.close.cancel"
  onconfirm={confirmDiscard}
  oncancel={cancelDiscard}
/>

<NotificationRegion />

<FeedbackOverlay bind:this={feedbackOverlay} />
