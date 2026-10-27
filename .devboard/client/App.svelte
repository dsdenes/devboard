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
  import IssuesWorkspace from "./lib/components/IssuesWorkspace.svelte";
  import NotificationRegion from "./lib/components/NotificationRegion.svelte";
  import PaneHandle from "./lib/components/PaneHandle.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import Button from "./lib/components/ui/button.svelte";
  import { buildCommands } from "./lib/commands";
  import { connection } from "./lib/connection.svelte";
  import { discover } from "./lib/discover.svelte";
  import { flow } from "./lib/flow.svelte";
  import { goal } from "./lib/goal.svelte";
  import { draftsPageWasOpen, issues } from "./lib/issues.svelte";
  import { scout } from "./lib/scout.svelte";
  import { applyTheme, layout } from "./lib/layout.svelte";
  import type { WorkspaceTab } from "./lib/layout.svelte";
  import { notifications } from "./lib/notifications.svelte";
  import type { FeedbackAction, FeedbackPhase, Mode } from "./lib/types";
  import { MINIMUM_VIEWPORT, viewport } from "./lib/viewport.svelte";

  interface PendingClose {
    mode: Mode;
    tab: WorkspaceTab;
  }

  interface FeedbackHandle {
    startPicking: () => void;
    startRemoving: () => void;
    startRedesigning: () => void;
    toggleReport: () => void;
    toggleAction: (action: FeedbackAction) => void;
    cancelReport: () => void;
  }

  const MODES: Mode[] = ["goal", "issues", "flow", "discover"];

  let paletteOpen = $state(false);
  let paletteReturnFocus: HTMLElement | null = null;
  let pendingClose = $state<PendingClose | null>(null);
  let feedbackOverlay = $state<FeedbackHandle>();
  let reportPhase = $state<FeedbackPhase>("idle");
  let reportAction = $state<FeedbackAction | null>(null);

  const savedFocus: Record<Mode, HTMLElement | null> = {
    goal: null,
    issues: null,
    flow: null,
    discover: null,
  };

  let sidebarGroup = $state<{ setLayout: (sizes: number[]) => void }>();
  let sidebarSizes = $state<number[]>([]);

  const availableWidth = $derived(Math.max(600, viewport.width - 64));
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
    if (mode === "flow" && tab.kind === "decisions") return flow.decisionsDirty;
    if (mode === "discover" && tab.kind === "skill") return discover.skillDirty(tab.resourceId);
    return false;
  }

  function focusModeAfterTick(mode: Mode): void {
    void tick().then(() => {
      document.getElementById(`mode-${mode}-tab`)?.focus();
    });
  }

  function performClose(mode: Mode, tab: WorkspaceTab): void {
    layout.closeTab(mode, tab.id);
    focusModeAfterTick(mode);
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
    if (pending.mode === "flow" && pending.tab.kind === "decisions") flow.discardDecisionsDraft();
    if (pending.mode === "discover" && pending.tab.kind === "skill") {
      discover.discardDraft(pending.tab.resourceId);
    }
    performClose(pending.mode, pending.tab);
  }

  function cancelDiscard(): void {
    pendingClose = null;
    focusModeAfterTick(layout.mode);
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
                : null;
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
    canCloseTab: () => pendingClose !== null,
    confirmCloseTab: () => confirmDiscard(),
    cancelCloseTab: () => cancelDiscard(),
  };

  const commands = $derived(buildCommands(commandsContext));

  let previousMode = layout.mode;
  let lastFlowConversation: string | null = null;
  let draftsRequested = false;

  // The sidebar's Drafts count needs the list before the page is opened; the
  // page itself refreshes while mounted.
  $effect(() => {
    if (connection.open && !draftsRequested) {
      draftsRequested = true;
      issues.refreshDrafts();
    } else if (!connection.open) {
      draftsRequested = false;
    }
  });

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
        title: "Drafts",
      });
    }
    viewport.update();
    const onResize = () => viewport.update();
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", handleKeydown, true);

    connection.onMessage((message) => {
      const record = message as Record<string, unknown>;
      goal.handleEvent(record);
      issues.handleEvent(record);
      scout.handleEvent(record);
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
              <IssuesWorkspace tab={workspaceTab("issues")} />
            {:else if mode === "flow"}
              <FlowMode
                tab={workspaceTab("flow")}
                openTab={(tab) => openTab("flow", tab)}
                closeTab={(tab) => closeTab("flow", tab)}
              />
            {:else}
              <DiscoverWorkspace tab={workspaceTab("discover")} />
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
        <ActivityBar
          onopenpalette={openPalette}
          onreportissue={() => feedbackOverlay?.toggleReport()}
          onremoveelement={() => feedbackOverlay?.toggleAction("remove")}
          onredesignelement={() => feedbackOverlay?.toggleAction("redesign")}
          reportphase={reportPhase}
          reportaction={reportAction}
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
          <Pane minSize={40} class="pane-fill">
            {@render workspaceArea()}
          </Pane>
        </PaneGroup>
      </div>
      <StatusBar />
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

<FeedbackOverlay
  bind:this={feedbackOverlay}
  bind:phase={reportPhase}
  bind:action={reportAction}
/>
