<script lang="ts">
  import { onMount, tick } from "svelte";
  import AgentOutput from "./AgentOutput.svelte";
  import FeedbackOverlay from "./FeedbackOverlay.svelte";
  import FlowMode from "./FlowMode.svelte";

  interface AdrRecord {
    file: string;
    title: string;
    status: string;
    pending: boolean;
    summary: string;
  }

  type RunAction = "resolving" | "implementing" | "generating";

  interface VersionState {
    running: string | null;
    current: string | null;
    stale: boolean;
  }

  interface RecordsEvent {
    type: "records";
    records: AdrRecord[];
    next: string | null;
  }

  interface RunQuestionOption {
    label: string;
    description?: string;
    recommended: boolean;
  }

  interface RunQuestion {
    id: number | string;
    message: string;
    options: RunQuestionOption[];
  }

  interface SkillSummary {
    name: string;
    description: string;
  }

  interface SkillContradiction {
    skills: [string, string];
    directives: [string, string];
  }

  type LifecycleStage = "goal" | "epic" | "adr" | "implementation" | "finished";

  interface LifecycleWork {
    kind: "adr" | "epic";
    id: string;
    url?: string;
  }

  interface LifecycleState {
    stage: LifecycleStage;
    pass: number;
    work: LifecycleWork | null;
    paused: boolean;
  }

  type LaneKind = "generation" | "implementation" | "adr";
  type LaneStatus = "running" | "paused" | "closed" | "failed" | "retrying" | "parked";

  interface LaneEpic {
    number: number;
    title: string;
    url: string;
  }

  interface Lane {
    id: string;
    kind: LaneKind;
    epic: LaneEpic | null;
    record: { file: string; title: string } | null;
    attempt: number;
    status: LaneStatus;
    activity: string[];
    question: RunQuestion | null;
  }

  interface LaneStateEvent {
    type: "laneState";
    lanes: Lane[];
    openEpics: number;
    runningLanes: number;
  }

  const STAGE_NAMES = new Set<string>(["goal", "epic", "adr", "implementation", "finished"]);

  let records = $state<AdrRecord[]>([]);
  let next = $state<string | null>(null);
  let projectPath = $state("");
  let connection = $state<"connecting" | "open" | "closed">("connecting");
  let error = $state<string | null>(null);
  let goalText = $state("");
  let goalReady = $state(false);
  let creationActive = $state(false);

  let runFile = $state<string | null>(null);
  let runTitle = $state<string | null>(null);
  let runAction = $state<RunAction>("resolving");
  let runState = $state<"idle" | "active" | "stopped">("idle");
  let manualRunActive = $state(false);
  let activity = $state<string[]>([]);
  let question = $state<RunQuestion | null>(null);
  let draft = $state("");
  let revisionActive = $state(false);
  let revisionRequest = $state("");
  let lifecycle = $state<LifecycleState>({ stage: "goal", pass: 1, work: null, paused: false });
  let lifecycleSeen = $state(false);
  let lanes = $state<Lane[]>([]);
  let openEpics = $state(0);
  let runningLanes = $state(0);
  let selectedLaneId = $state<string | null>(null);
  let laneDraft = $state("");
  let skills = $state<SkillSummary[]>([]);
  let contradictions = $state<SkillContradiction[]>([]);
  let skillsPrepActive = $state(false);
  let resetArmed = $state(false);
  let resetting = $state(false);
  let resetStatus = $state<string | null>(null);
  let skillsOpen = $state(false);
  let adrsOpen = $state(false);
  let version = $state<VersionState | null>(null);
  let restarting = $state(false);
  let awaitingRestart = $state(false);
  let upgradePending = $state(false);

  type ViewName = "goal" | "flow";

  interface SavedViewState {
    focus: HTMLElement | null;
    scrolls: Array<[Element, number]>;
  }

  let mode = $state<ViewName>("goal");
  let goalViewEl: HTMLDivElement;
  let flowViewEl: HTMLDivElement;
  let flowComponent: FlowMode;
  const savedViews: Record<ViewName, SavedViewState> = {
    goal: { focus: null, scrolls: [] },
    flow: { focus: null, scrolls: [] },
  };

  let pendingCount = $derived(records.filter((record) => record.pending).length);
  let running = $derived(runState === "active");
  let lifecycleActive = $derived(
    lifecycleSeen &&
      (lifecycle.paused ||
        lifecycle.stage === "adr" ||
        lifecycle.stage === "implementation" ||
        (lifecycle.stage === "epic" && lifecycle.work === null)),
  );
  let controlsDisabled = $derived(
    running || lifecycleActive || revisionActive || creationActive || skillsPrepActive,
  );
  let runStartDisabled = $derived(
    creationActive ||
      revisionActive ||
      skillsPrepActive ||
      manualRunActive ||
      (!lifecycleActive && running),
  );
  let revisionDisabled = $derived(
    creationActive ||
      skillsPrepActive ||
      manualRunActive ||
      (lifecycleActive ? !lifecycle.paused : running),
  );
  let lifecycleButtonDisabled = $derived(
    connection !== "open"
      ? true
      : lifecycleActive
        ? resetting || creationActive || revisionActive || skillsPrepActive
        : resetting || controlsDisabled || !goalReady || !skillsPrepared,
  );
  let createGoalTitle = $derived(
    creationActive
      ? "Restart goal creation."
      : goalReady
        ? "Start a new goal creation and replace the current goal."
        : running || lifecycleActive || revisionActive
          ? "Stop the active run and start goal creation."
          : "Start goal creation.",
  );
  let goalEditingDisabled = $derived(
    (lifecycleActive && !lifecycle.paused) || skillsPrepActive,
  );
  let prepareDisabled = $derived(controlsDisabled || !goalReady);
  let resetDisabled = $derived(connection !== "open" || resetting);
  let skillsPrepared = $derived(skills.length > 0);
  let startLifecycleTitle = $derived(
    !goalReady
      ? "Save a non-empty goal before starting the lifecycle."
      : !skillsPrepared
        ? "Prepare skills before starting the lifecycle."
        : undefined,
  );
  let lifecycleButtonTitle = $derived(
    lifecycleActive
      ? "Stop the lifecycle and its current run."
      : startLifecycleTitle,
  );
  let runStartTitle = $derived(
    lifecycleActive
      ? "Interrupt the lifecycle and resolve the ADRs manually."
      : undefined,
  );
  let activityActive = $derived(running || creationActive || revisionActive || skillsPrepActive);
  let currentAction = $derived(activity[activity.length - 1] ?? "");
  let previousActions = $derived(activity.slice(0, -1));
  let previousActionsLabel = $derived(
    previousActions.length === 1
      ? "1 previous action"
      : `${previousActions.length} previous actions`,
  );
  let lifecycleWorkTitle = $derived(
    lifecycle.work === null
      ? null
      : lifecycle.work.kind === "epic"
        ? `Epic #${lifecycle.work.id}`
        : (records.find((record) => record.file === lifecycle.work?.id)?.title ??
          lifecycle.work.id),
  );
  let lifecycleWorkUrl = $derived(
    lifecycle.work?.kind === "epic" ? (lifecycle.work.url ?? null) : null,
  );
  let selectedLane = $derived(lanes.find((lane) => lane.id === selectedLaneId) ?? null);
  let selectedLaneActivity = $derived(selectedLane?.activity ?? []);
  let selectedLaneCurrent = $derived(
    selectedLaneActivity[selectedLaneActivity.length - 1] ?? "",
  );
  let selectedLaneHistory = $derived(selectedLaneActivity.slice(0, -1));

  let socket: WebSocket | undefined;
  let retryTimer: number | undefined;
  let disposed = false;

  function isRecord(value: unknown): value is AdrRecord {
    return (
      typeof value === "object" &&
      value !== null &&
      "file" in value &&
      typeof value.file === "string" &&
      "title" in value &&
      typeof value.title === "string" &&
      "status" in value &&
      typeof value.status === "string" &&
      "pending" in value &&
      typeof value.pending === "boolean" &&
      "summary" in value &&
      typeof value.summary === "string"
    );
  }

  function isRecordsEvent(value: unknown): value is RecordsEvent {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "records" &&
      "records" in value &&
      Array.isArray(value.records) &&
      value.records.every(isRecord) &&
      "next" in value &&
      (value.next === null || typeof value.next === "string")
    );
  }

  function isErrorEvent(value: unknown): value is { type: "error"; message: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "error" &&
      "message" in value &&
      typeof value.message === "string"
    );
  }

  function isProjectEvent(value: unknown): value is { type: "project"; path: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "project" &&
      "path" in value &&
      typeof value.path === "string"
    );
  }

  function isGoalEvent(value: unknown): value is { type: "goal"; text: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goal" &&
      "text" in value &&
      typeof value.text === "string"
    );
  }

  function isGoalRevisionStartedEvent(
    value: unknown,
  ): value is { type: "goalRevisionStarted" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalRevisionStarted"
    );
  }

  function isGoalRevisionStoppedEvent(
    value: unknown,
  ): value is { type: "goalRevisionStopped"; completed: boolean; text?: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalRevisionStopped" &&
      "completed" in value &&
      typeof value.completed === "boolean" &&
      (!("text" in value) || typeof value.text === "string")
    );
  }

  function isGoalCreationStartedEvent(
    value: unknown,
  ): value is { type: "goalCreationStarted" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalCreationStarted"
    );
  }

  function isGoalCreationStoppedEvent(
    value: unknown,
  ): value is { type: "goalCreationStopped"; completed: boolean; text?: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "goalCreationStopped" &&
      "completed" in value &&
      typeof value.completed === "boolean" &&
      (!("text" in value) || typeof value.text === "string")
    );
  }

  function isSkillSummary(value: unknown): value is SkillSummary {
    return (
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      typeof value.name === "string" &&
      "description" in value &&
      typeof value.description === "string"
    );
  }

  function isSkillContradiction(value: unknown): value is SkillContradiction {
    return (
      typeof value === "object" &&
      value !== null &&
      "skills" in value &&
      Array.isArray(value.skills) &&
      value.skills.length === 2 &&
      value.skills.every((name) => typeof name === "string") &&
      "directives" in value &&
      Array.isArray(value.directives) &&
      value.directives.length === 2 &&
      value.directives.every((directive) => typeof directive === "string")
    );
  }

  function isSkillsStateEvent(
    value: unknown,
  ): value is { type: "skillsState"; skills: SkillSummary[]; contradictions: SkillContradiction[] } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "skillsState" &&
      "skills" in value &&
      Array.isArray(value.skills) &&
      value.skills.every(isSkillSummary) &&
      "contradictions" in value &&
      Array.isArray(value.contradictions) &&
      value.contradictions.every(isSkillContradiction)
    );
  }

  function isSkillsPreparationStartedEvent(
    value: unknown,
  ): value is { type: "skillsPreparationStarted" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "skillsPreparationStarted"
    );
  }

  function isSkillsPreparationStoppedEvent(
    value: unknown,
  ): value is {
    type: "skillsPreparationStopped";
    completed: boolean;
    skills?: SkillSummary[];
    contradictions?: SkillContradiction[];
  } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "skillsPreparationStopped" &&
      "completed" in value &&
      typeof value.completed === "boolean" &&
      (!("skills" in value) ||
        (Array.isArray(value.skills) && value.skills.every(isSkillSummary))) &&
      (!("contradictions" in value) ||
        (Array.isArray(value.contradictions) && value.contradictions.every(isSkillContradiction)))
    );
  }

  function isRunStartedEvent(
    value: unknown,
  ): value is {
    type: "runStarted";
    file: string;
    title: string;
    action?: RunAction;
    manual?: boolean;
    lane?: string;
  } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "runStarted" &&
      "file" in value &&
      typeof value.file === "string" &&
      "title" in value &&
      typeof value.title === "string" &&
      (!("action" in value) ||
        value.action === "resolving" ||
        value.action === "implementing" ||
        value.action === "generating") &&
      (!("manual" in value) || typeof value.manual === "boolean")
    );
  }

  function isVersionStateEvent(value: unknown): value is { type: "versionState" } & VersionState {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "versionState" &&
      "running" in value &&
      (value.running === null || typeof value.running === "string") &&
      "current" in value &&
      (value.current === null || typeof value.current === "string") &&
      "stale" in value &&
      typeof value.stale === "boolean"
    );
  }

  function isServerRestartingEvent(value: unknown): value is { type: "serverRestarting" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "serverRestarting"
    );
  }

  function isUpgradePendingEvent(value: unknown): value is { type: "upgradePending" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "upgradePending"
    );
  }

  function isActivityEvent(
    value: unknown,
  ): value is { type: "activity"; text: string; append?: boolean; lane?: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "activity" &&
      "text" in value &&
      typeof value.text === "string" &&
      (!("lane" in value) || typeof value.lane === "string")
    );
  }

  function isQuestionOption(value: unknown): value is RunQuestionOption {
    return (
      typeof value === "object" &&
      value !== null &&
      "label" in value &&
      typeof value.label === "string" &&
      (!("description" in value) ||
        value.description === undefined ||
        typeof value.description === "string") &&
      "recommended" in value &&
      typeof value.recommended === "boolean"
    );
  }

  function isQuestionEvent(
    value: unknown,
  ): value is { type: "question"; lane?: string } & RunQuestion {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "question" &&
      "id" in value &&
      (typeof value.id === "string" || typeof value.id === "number") &&
      "message" in value &&
      typeof value.message === "string" &&
      "options" in value &&
      Array.isArray(value.options) &&
      value.options.every(isQuestionOption) &&
      (!("lane" in value) || typeof value.lane === "string")
    );
  }

  function isRunStoppedEvent(
    value: unknown,
  ): value is {
    type: "runStopped";
    file: string;
    title: string;
    resolved: boolean;
    status: string;
    lane?: string;
  } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "runStopped" &&
      "file" in value &&
      typeof value.file === "string" &&
      "title" in value &&
      typeof value.title === "string" &&
      "resolved" in value &&
      typeof value.resolved === "boolean" &&
      "status" in value &&
      typeof value.status === "string"
    );
  }

  function isImplementationResetStartedEvent(
    value: unknown,
  ): value is { type: "implementationResetStarted" } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "implementationResetStarted"
    );
  }

  function isImplementationResetStoppedEvent(
    value: unknown,
  ): value is { type: "implementationResetStopped"; completed: boolean; commit?: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "implementationResetStopped" &&
      "completed" in value &&
      typeof value.completed === "boolean" &&
      (!("commit" in value) || typeof value.commit === "string")
    );
  }

  function isLifecycleStateEvent(
    value: unknown,
  ): value is { type: "lifecycleState" } & LifecycleState {
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      value.type !== "lifecycleState" ||
      !("stage" in value) ||
      typeof value.stage !== "string" ||
      !STAGE_NAMES.has(value.stage) ||
      !("pass" in value) ||
      typeof value.pass !== "number" ||
      !("work" in value) ||
      !("paused" in value) ||
      typeof value.paused !== "boolean"
    ) {
      return false;
    }

    if (value.work === null) return true;
    return (
      typeof value.work === "object" &&
      value.work !== null &&
      "kind" in value.work &&
      (value.work.kind === "adr" || value.work.kind === "epic") &&
      "id" in value.work &&
      (typeof value.work.id === "string" || typeof value.work.id === "number") &&
      (!("url" in value.work) ||
        value.work.url === undefined ||
        typeof value.work.url === "string")
    );
  }

  function isLaneStatus(value: unknown): value is LaneStatus {
    return (
      value === "running" ||
      value === "paused" ||
      value === "closed" ||
      value === "failed" ||
      value === "retrying" ||
      value === "parked"
    );
  }

  function isLaneEpic(value: unknown): value is LaneEpic {
    return (
      typeof value === "object" &&
      value !== null &&
      "number" in value &&
      typeof value.number === "number" &&
      "title" in value &&
      typeof value.title === "string" &&
      "url" in value &&
      typeof value.url === "string"
    );
  }

  function isLaneRecord(value: unknown): value is { file: string; title: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "file" in value &&
      typeof value.file === "string" &&
      "title" in value &&
      typeof value.title === "string"
    );
  }

  function isLane(value: unknown): value is Lane {
    return (
      typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      "kind" in value &&
      (value.kind === "generation" || value.kind === "implementation" || value.kind === "adr") &&
      "attempt" in value &&
      typeof value.attempt === "number" &&
      "status" in value &&
      isLaneStatus(value.status) &&
      "epic" in value &&
      (value.epic === null || isLaneEpic(value.epic)) &&
      "record" in value &&
      (value.record === null || isLaneRecord(value.record)) &&
      "activity" in value &&
      Array.isArray(value.activity) &&
      value.activity.every((line) => typeof line === "string") &&
      "question" in value &&
      (value.question === null ||
        (typeof value.question === "object" &&
          value.question !== null &&
          "id" in value.question &&
          (typeof value.question.id === "string" || typeof value.question.id === "number") &&
          "message" in value.question &&
          typeof value.question.message === "string" &&
          "options" in value.question &&
          Array.isArray(value.question.options) &&
          value.question.options.every(isQuestionOption)))
    );
  }

  function isLaneStateEvent(value: unknown): value is LaneStateEvent {
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "laneState" &&
      "lanes" in value &&
      Array.isArray(value.lanes) &&
      value.lanes.every(isLane) &&
      "openEpics" in value &&
      typeof value.openEpics === "number" &&
      "runningLanes" in value &&
      typeof value.runningLanes === "number"
    );
  }

  /** Sends one command. Every command other than arming disarms a pending reset. */
  function sendCommand(command: unknown): boolean {
    resetArmed = false;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      error = "Not connected to the server.";
      return false;
    }
    error = null;
    socket.send(JSON.stringify(command));
    return true;
  }

  function armReset() {
    if (resetDisabled) return;
    resetArmed = true;
  }

  function confirmReset() {
    if (!resetArmed || resetDisabled) return;
    sendCommand({ type: "resetImplementation" });
  }

  function start(target?: string) {
    sendCommand(
      target === undefined ? { type: "startRun" } : { type: "startRun", file: target },
    );
  }

  function toggleLifecycle() {
    if (lifecycleActive) sendCommand({ type: "stopLifecycle" });
    else sendCommand({ type: "startLifecycle" });
  }

  function saveGoal() {
    sendCommand({ type: "saveGoal", text: goalText });
  }

  function createGoal() {
    sendCommand({ type: "createGoal" });
  }

  function prepareSkills() {
    sendCommand({ type: "prepareSkills" });
  }

  function requestRestart() {
    if (restarting) return;
    restarting = true;
    if (!sendCommand({ type: "restartServer" })) restarting = false;
  }

  async function waitForRestart() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch("/", { cache: "no-store", method: "HEAD" });
        if (response.ok) {
          location.reload();
          return;
        }
      } catch {
        // The replacement is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    awaitingRestart = false;
    restarting = false;
    error = "The server did not come back after the restart.";
    connect();
  }

  function closeOverlays() {
    adrsOpen = false;
    skillsOpen = false;
  }

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") closeOverlays();
  }

  /**
   * The view remembers the last control focused inside it. Switching tabs moves
   * focus to the tab button before the click handler runs, so reading
   * `document.activeElement` at switch time would lose the developer's place.
   */
  function rememberFocus(view: ViewName, event: FocusEvent): void {
    const target = event.target;
    if (target instanceof HTMLElement) savedViews[view].focus = target;
  }

  function captureViewState(view: HTMLDivElement | undefined): SavedViewState {
    const state: SavedViewState = { focus: null, scrolls: [] };
    if (view === undefined) return state;

    const active = document.activeElement;
    if (active instanceof HTMLElement && view.contains(active)) state.focus = active;

    if (view.scrollTop !== 0) state.scrolls.push([view, view.scrollTop]);
    for (const element of view.querySelectorAll("*")) {
      if (element.scrollTop !== 0) state.scrolls.push([element, element.scrollTop]);
    }
    return state;
  }

  function restoreViewState(view: HTMLDivElement | undefined, state: SavedViewState): void {
    if (view === undefined) return;
    for (const [element, top] of state.scrolls) {
      if (element.isConnected) element.scrollTop = top;
    }
    if (state.focus !== null && state.focus.isConnected) {
      state.focus.focus({ preventScroll: true });
    }
  }

  /** Purely local: switching modes never sends or clears anything. */
  function selectMode(next: ViewName) {
    if (next === mode) return;
    const outgoing = mode;
    const captured = captureViewState(outgoing === "goal" ? goalViewEl : flowViewEl);
    // A click on the switch already moved focus out of the outgoing view; the
    // remembered control is the developer's actual place in it.
    savedViews[outgoing] = {
      ...captured,
      focus: captured.focus ?? savedViews[outgoing].focus,
    };
    mode = next;
    void tick().then(() => {
      restoreViewState(
        next === "goal" ? goalViewEl : flowViewEl,
        savedViews[next],
      );
    });
  }

  function reviseGoal() {
    const request = revisionRequest.trim();
    sendCommand(
      request.length === 0 ? { type: "reviseGoal" } : { type: "reviseGoal", request },
    );
  }

  function submitAnswer(value: string) {
    if (question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    const id = question.id;
    question = null;
    draft = "";
    sendCommand({ type: "answer", id, value: trimmed });
  }

  /** Sends an answer to the selected lane only, leaving every other lane alone. */
  function submitLaneAnswer(value: string) {
    if (selectedLane === null || selectedLane.question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    const lane = selectedLane;
    const id = lane.question.id;
    lanes = lanes.map((entry) =>
      entry.id === lane.id ? { ...entry, question: null } : entry,
    );
    laneDraft = "";
    sendCommand({ type: "answer", lane: lane.id, id, value: trimmed });
  }

  function laneLabel(lane: Lane): string {
    const base =
      lane.kind === "generation"
        ? "Epic generation"
        : lane.kind === "adr"
          ? (lane.record?.title ?? lane.record?.file ?? "ADR resolution")
          : `Epic #${lane.epic?.number ?? ""}`;
    return lane.attempt > 1 ? `${base} (attempt ${lane.attempt})` : base;
  }

  function laneIdentity(lane: Lane): string {
    if (lane.kind === "generation") return "Epic generation";
    if (lane.kind === "adr") {
      return `${lane.record?.title ?? ""} (${lane.record?.file ?? ""})`;
    }
    return `${lane.epic?.title ?? ""} — ${lane.epic?.url ?? ""}`;
  }

  function selectLane(id: string) {
    selectedLaneId = id;
    laneDraft = "";
  }

  function connect() {
    connection = "connecting";
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(`${protocol}//${location.host}/ws`);
    socket = current;

    current.onopen = () => {
      connection = "open";
      error = null;
      resetArmed = false;
      manualRunActive = false;
      upgradePending = false;
      current.send(JSON.stringify({ type: "listRecords" }));
      current.send(JSON.stringify({ type: "getGoal" }));
      current.send(JSON.stringify({ type: "getSkills" }));
      current.send(JSON.stringify({ type: "getProject" }));
      current.send(JSON.stringify({ type: "getVersion" }));
    };

    current.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      flowComponent?.handleEvent(message);

      if (isVersionStateEvent(message)) {
        version = {
          running: message.running,
          current: message.current,
          stale: message.stale,
        };
      } else if (isServerRestartingEvent(message)) {
        awaitingRestart = true;
        restarting = true;
        upgradePending = false;
        error = null;
        socket?.close();
      } else if (isUpgradePendingEvent(message)) {
        upgradePending = true;
      } else if (isImplementationResetStartedEvent(message)) {
        resetting = true;
        resetArmed = false;
        resetStatus = null;
        error = null;
      } else if (isImplementationResetStoppedEvent(message)) {
        resetting = false;
        resetArmed = false;
        resetStatus = message.completed
          ? `Reset committed as ${message.commit ?? "an unknown commit"}.`
          : "Reset did not complete.";
        if (message.completed) error = null;
      } else if (isLifecycleStateEvent(message)) {
        lifecycle = {
          stage: message.stage,
          pass: message.pass,
          work:
            message.work === null
              ? null
              : {
                  kind: message.work.kind,
                  id: String(message.work.id),
                  ...(typeof message.work.url === "string"
                    ? { url: message.work.url }
                    : {}),
                },
          paused: message.paused,
        };
        if (message.stage !== "goal" || message.paused) lifecycleSeen = true;
      } else if (isRecordsEvent(message)) {
        records = message.records;
        next = message.next;
      } else if (isProjectEvent(message)) {
        projectPath = message.path;
      } else if (isGoalEvent(message)) {
        if (!revisionActive && !creationActive) {
          goalText = message.text;
          goalReady = message.text.trim().length > 0;
        }
        error = null;
      } else if (isGoalCreationStartedEvent(message)) {
        creationActive = true;
        activity = [];
        question = null;
        draft = "";
        error = null;
      } else if (isGoalCreationStoppedEvent(message)) {
        creationActive = false;
        question = null;
        draft = "";
        if (message.completed && typeof message.text === "string") {
          goalText = message.text;
          goalReady = message.text.trim().length > 0;
        }
      } else if (isGoalRevisionStartedEvent(message)) {
        revisionActive = true;
        activity = [];
        question = null;
        draft = "";
        error = null;
      } else if (isGoalRevisionStoppedEvent(message)) {
        revisionActive = false;
        question = null;
        draft = "";
        if (message.completed && typeof message.text === "string") {
          goalText = message.text;
          goalReady = message.text.trim().length > 0;
        }
      } else if (isSkillsPreparationStartedEvent(message)) {
        skillsPrepActive = true;
        activity = [];
        question = null;
        draft = "";
        error = null;
      } else if (isSkillsPreparationStoppedEvent(message)) {
        skillsPrepActive = false;
        question = null;
        draft = "";
        if (message.completed && message.skills !== undefined) {
          skills = message.skills;
          contradictions = message.contradictions ?? [];
        }
      } else if (isSkillsStateEvent(message)) {
        if (!skillsPrepActive) {
          skills = message.skills;
          contradictions = message.contradictions;
        }
      } else if (isLaneStateEvent(message)) {
        lanes = message.lanes;
        openEpics = message.openEpics;
        runningLanes = message.runningLanes;
        if (selectedLaneId === null || !lanes.some((lane) => lane.id === selectedLaneId)) {
          selectedLaneId =
            lanes.find((lane) => lane.status === "running")?.id ??
            lanes[lanes.length - 1]?.id ??
            null;
        }
      } else if (isRunStartedEvent(message)) {
        if (message.lane === undefined) {
          runFile = message.file;
          runTitle = message.title;
          runAction = message.action ?? "resolving";
          runState = "active";
          manualRunActive = message.manual === true;
          activity = [];
          question = null;
          draft = "";
          error = null;
        }
      } else if (isActivityEvent(message)) {
        if (message.lane !== undefined) {
          const laneId = message.lane;
          lanes = lanes.map((lane) => {
            if (lane.id !== laneId) return lane;
            const next = [...lane.activity];
            if (message.append === true && next.length > 0) {
              next[next.length - 1] += message.text;
            } else {
              next.push(message.text);
            }
            return { ...lane, activity: next };
          });
        } else if (message.append === true && activity.length > 0) {
          activity = [
            ...activity.slice(0, -1),
            activity[activity.length - 1] + message.text,
          ];
        } else {
          activity = [...activity, message.text];
        }
      } else if (isQuestionEvent(message)) {
        if (message.lane !== undefined) {
          const laneId = message.lane;
          lanes = lanes.map((lane) =>
            lane.id === laneId
              ? {
                  ...lane,
                  question: {
                    id: message.id,
                    message: message.message,
                    options: message.options,
                  },
                }
              : lane,
          );
        } else {
          question = { id: message.id, message: message.message, options: message.options };
          draft = "";
        }
      } else if (isRunStoppedEvent(message)) {
        if (message.lane === undefined) {
          runFile = null;
          runTitle = null;
          runState = "stopped";
          manualRunActive = false;
          question = null;
          draft = "";
        }
      } else if (isErrorEvent(message)) {
        error = message.message;
        if (restarting) {
          awaitingRestart = false;
          restarting = false;
        }
      }
    };

    current.onerror = () => {
      if (!awaitingRestart) error = "Could not reach the server.";
    };

    current.onclose = () => {
      connection = "closed";
      resetArmed = false;
      if (awaitingRestart) {
        void waitForRestart();
        return;
      }
      if (!disposed) retryTimer = window.setTimeout(connect, 1000);
    };
  }

  onMount(() => {
    connect();
    const versionTimer = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "getVersion" }));
      }
    }, 3000);

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearInterval(versionTimer);
      socket?.close();
    };
  });
</script>

{#snippet goalEditor()}
  <textarea
    id="goal-text"
    class="goal-text"
    bind:value={goalText}
    disabled={goalEditingDisabled}
    aria-label="Current goal"
    data-testid="goal-text"
  ></textarea>
  <button
    type="button"
    class="start-button save-goal"
    data-testid="save-goal"
    disabled={goalEditingDisabled}
    onclick={saveGoal}
  >
    Save goal
  </button>

  <div class="goal-revision">
    <label class="goal-label" for="revision-request">Revision guidance</label>
    <div class="revision-controls">
      <input
        id="revision-request"
        class="revision-request"
        type="text"
        bind:value={revisionRequest}
        placeholder="Optional guidance for the agent"
        data-testid="revision-request"
        disabled={revisionDisabled}
      />
      <button
        type="button"
        class="start-button"
        data-testid="revise-goal"
        disabled={revisionDisabled}
        onclick={reviseGoal}
      >
        Revise goal
      </button>
    </div>
  </div>
{/snippet}

<svelte:head>
  <title>{projectPath.trim().length > 0 ? projectPath : "Devboard"}</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<main>
  <div class="mode-switch" role="tablist" aria-label="Devboard mode">
    <button
      type="button"
      class="mode-tab"
      role="tab"
      id="mode-goal-tab"
      aria-controls="goal-view"
      aria-selected={mode === "goal"}
      data-testid="mode-goal"
      onclick={() => selectMode("goal")}
    >
      Goal
    </button>
    <button
      type="button"
      class="mode-tab"
      role="tab"
      id="mode-flow-tab"
      aria-controls="flow-view"
      aria-selected={mode === "flow"}
      data-testid="mode-flow"
      onclick={() => selectMode("flow")}
    >
      Flow
    </button>
  </div>

  <div
    class="mode-view"
    id="goal-view"
    role="tabpanel"
    aria-labelledby="mode-goal-tab"
    bind:this={goalViewEl}
    hidden={mode !== "goal"}
    onfocusin={(event) => rememberFocus("goal", event)}
  >
  <header class="page-header">
    <div class="heading-row">
      <div>
        <h1>{projectPath}</h1>
        {#if pendingCount > 0}
          <p class="pending-summary" data-testid="pending-summary" aria-live="polite">
            {pendingCount}
            {pendingCount === 1 ? "ADR pending" : "ADRs pending"}
          </p>
        {/if}
      </div>
      <div class="header-actions">
        {#if version?.stale}
          <button
            type="button"
            class="icon-button reload-button"
            data-testid="reload-devboard"
            title="A different devboard version is installed. Restart the server and reload."
            aria-label="Restart the devboard server and reload"
            disabled={restarting}
            onclick={requestRestart}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5V6H10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {/if}
        <button
          type="button"
          class="start-button adrs-button"
          data-testid="open-adrs"
          onclick={() => (adrsOpen = true)}
        >
          ADRs
        </button>
        <button
          type="button"
          class="start-button"
          data-testid="lifecycle-control"
          class:stop-button={lifecycleActive}
          title={lifecycleButtonTitle}
          disabled={lifecycleButtonDisabled}
          onclick={toggleLifecycle}
        >
          {lifecycleActive ? "Stop implementation" : "Start implementation"}
        </button>
        {#if pendingCount > 0}
          <button
            class="start-button resolve-button"
            data-testid="start-next"
            title={runStartTitle}
            disabled={runStartDisabled}
            onclick={() => start()}
          >
            Resolve ADRs
          </button>
        {/if}
        <button
          type="button"
          class="start-button reset-button"
          data-testid="reset-implementation"
          disabled={resetDisabled}
          onclick={armReset}
        >
          Reset implementation
        </button>
      </div>
    </div>

    {#if resetArmed}
      <div class="reset-confirmation" data-testid="reset-confirmation">
        <p class="reset-keep-set" data-testid="reset-keep-set">
          Reset deletes every top-level entry except
          <code>.devboard</code>, <code>.omp</code>, <code>AGENTS.md</code>,
          <code>.gitignore</code>, and <code>GOAL.md</code>. The internal
          <code>.git</code> and <code>.worktree</code> directories are preserved.
          Any active run, lifecycle, goal creation, revision, or skills
          preparation stops first.
        </p>
        <div class="reset-actions">
          <button
            type="button"
            class="start-button reset-confirm"
            data-testid="confirm-reset"
            disabled={resetDisabled}
            onclick={confirmReset}
          >
            Confirm reset
          </button>
          <button
            type="button"
            class="start-button reset-cancel"
            data-testid="cancel-reset"
            onclick={() => (resetArmed = false)}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}

    {#if resetting}
      <p class="reset-running" data-testid="reset-running">Resetting implementation…</p>
    {/if}

    {#if resetStatus}
      <p class="reset-status" data-testid="reset-status" role="status">{resetStatus}</p>
    {/if}
  </header>

  <section class="lifecycle" data-testid="lifecycle">
    <p class="lifecycle-line">
      Open epics <strong data-testid="epic-count">{openEpics}</strong>
    </p>
    <p class="lifecycle-line">
      Running lanes <strong data-testid="lane-count">{runningLanes}</strong>
    </p>
    <p class="lifecycle-line">
      Pass <strong data-testid="lifecycle-pass">{lifecycle.pass}</strong>
    </p>
    {#if lifecycleWorkTitle !== null}
      <p class="lifecycle-work" data-testid="lifecycle-work">
        {#if lifecycleWorkUrl !== null}
          <a
            href={lifecycleWorkUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="lifecycle-work-link"
          >
            {lifecycleWorkTitle}
          </a>
        {:else}
          {lifecycleWorkTitle}
        {/if}
      </p>
    {/if}
  </section>

  {#if lanes.length > 0}
    <section class="lanes" data-testid="lane-tabs">
      <div class="lane-tab-row" role="tablist" aria-label="Agent lanes">
        {#each lanes as lane (lane.id)}
          <button
            type="button"
            class="lane-tab"
            class:selected={lane.id === selectedLaneId}
            role="tab"
            aria-selected={lane.id === selectedLaneId}
            data-testid="lane-tab"
            data-lane={lane.id}
            data-kind={lane.kind}
            data-epic={lane.epic === null ? undefined : String(lane.epic.number)}
            data-record={lane.record?.file}
            data-attempt={lane.attempt}
            data-status={lane.status}
            aria-label="{laneLabel(lane)} ({lane.status})"
            onclick={() => selectLane(lane.id)}
          >
            <span class="lane-label">{laneLabel(lane)}</span>
          </button>
        {/each}
      </div>

      {#if selectedLane !== null}
        <div class="lane-panel" data-testid="lane-panel" data-lane={selectedLane.id}>
          <p class="lane-identity" data-testid="lane-identity">{laneIdentity(selectedLane)}</p>
          <p
            class="lane-status"
            data-testid="lane-status"
            data-kind={selectedLane.kind}
            data-status={selectedLane.status}
          >
            {selectedLane.status}
          </p>

          {#if selectedLaneActivity.length > 0}
            <div class="activity-current" data-testid="lane-current">
              <AgentOutput text={selectedLaneCurrent} />
            </div>
            {#if selectedLaneHistory.length > 0}
              <details class="activity-history">
                <summary data-testid="lane-history">
                  {selectedLaneHistory.length}
                  {selectedLaneHistory.length === 1 ? "previous action" : "previous actions"}
                </summary>
                <ol class="activity-log" data-testid="lane-history-log">
                  {#each [...selectedLaneHistory].reverse() as line, index (index)}
                    <li><AgentOutput text={line} /></li>
                  {/each}
                </ol>
              </details>
            {/if}
          {/if}

          {#if selectedLane.question !== null}
            <div class="question" data-testid="lane-question" data-lane={selectedLane.id}>
              <p class="question-message">{selectedLane.question.message}</p>

              {#if selectedLane.question.options.length > 0}
                <div class="choices">
                  {#each selectedLane.question.options as option (option.label)}
                    <button
                      type="button"
                      class="choice"
                      data-testid="lane-choice"
                      onclick={() => submitLaneAnswer(option.label)}
                    >
                      <span class="choice-label">
                        {option.label}
                        {#if option.recommended}
                          <span class="choice-recommended">Recommended</span>
                        {/if}
                      </span>
                      {#if option.description}
                        <span class="choice-description">{option.description}</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}

              <form
                class="answer-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  submitLaneAnswer(laneDraft);
                }}
              >
                <input
                  type="text"
                  bind:value={laneDraft}
                  placeholder="Your answer"
                  aria-label="Your answer"
                  data-testid="lane-answer-input"
                />
                <button
                  type="submit"
                  data-testid="lane-submit-answer"
                  disabled={laneDraft.trim().length === 0}
                >
                  Submit answer
                </button>
              </form>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  {#if connection !== "open"}
    <p class="connection" role="status">
      {connection === "connecting" ? "Connecting to the server…" : "Connection lost. Reconnecting…"}
    </p>
  {/if}

  {#if upgradePending}
    <p class="upgrade-pending" data-testid="upgrade-pending" role="status">
      An update is waiting for the current work to finish. This dashboard restarts when it ends.
    </p>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <section class="goal" data-testid="goal-editor">
    <div class="goal-heading">
      <span class="goal-label">Current goal</span>
      {#if skills.length > 0}
        <button
          type="button"
          class="start-button prepare-skills"
          data-testid="show-skills"
          onclick={() => (skillsOpen = true)}
        >
          Show skills ({skills.length})
        </button>
      {:else}
        <button
          type="button"
          class="start-button prepare-skills"
          data-testid="prepare-skills"
          disabled={prepareDisabled}
          onclick={prepareSkills}
        >
          Prepare Skills
        </button>
      {/if}
      <button
        type="button"
        class="start-button create-goal"
        data-testid="create-goal"
        title={createGoalTitle}
        disabled={connection !== "open"}
        onclick={createGoal}
      >
        {goalReady ? "Recreate goal" : "Create goal"}
      </button>
    </div>
    {#if goalReady}
      <details class="goal-details" data-testid="goal-details">
        <summary class="goal-summary">Goal document</summary>
        {@render goalEditor()}
      </details>
    {:else}
      {@render goalEditor()}
    {/if}
  </section>

  {#if creationActive}
    <section class="run active-run" data-testid="goal-creation-active">
      <p class="run-heading">Creating <strong>the goal</strong></p>
    </section>
  {/if}

  {#if revisionActive}
    <section class="run active-run" data-testid="goal-revision-active">
      <p class="run-heading">Revising <strong>the goal</strong></p>
    </section>
  {/if}

  {#if skillsPrepActive}
    <section class="run active-run" data-testid="skills-preparation-active">
      <p class="run-heading">Preparing <strong>skills</strong></p>
    </section>
  {/if}

  {#if runState === "active" && runTitle !== null}
    <section class="run active-run" data-testid="active-run" data-action={runAction}>
      <p class="run-heading">
        {#if runAction === "implementing"}
          Implementing <strong>{runTitle}</strong>
        {:else if runAction === "generating"}
          Generating <strong>the next epic</strong>
        {:else}
          Resolving <strong>{runTitle}</strong>
        {/if}
      </p>
    </section>
  {:else if runState === "stopped"}
    <p class="run stopped-run" data-testid="run-stopped">Run stopped</p>
  {/if}

  {#if activity.length > 0}
    <section class="activity" class:live={activityActive} data-testid="activity">
      <div class="activity-heading">
        <span class="activity-dot" class:live={activityActive} aria-hidden="true"></span>
        <h2>{activityActive ? "Current action" : "Last action"}</h2>
      </div>
      <div class="activity-current" data-testid="activity-current">
        <AgentOutput text={currentAction} />
      </div>
      {#if previousActions.length > 0}
        <details class="activity-history">
          <summary data-testid="activity-history">{previousActionsLabel}</summary>
          <ol class="activity-log" data-testid="activity-log">
            {#each [...previousActions].reverse() as line, index (index)}
              <li><AgentOutput text={line} /></li>
            {/each}
          </ol>
        </details>
      {/if}
    </section>
  {/if}

  {#if question !== null}
    <section class="question" data-testid="question">
      <p class="question-message">{question.message}</p>

      {#if question.options.length > 0}
        <div class="choices">
          {#each question.options as option (option.label)}
            <button
              type="button"
              class="choice"
              data-testid="choice"
              onclick={() => submitAnswer(option.label)}
            >
              <span class="choice-label">
                {option.label}
                {#if option.recommended}
                  <span class="choice-recommended" data-testid="recommended">Recommended</span>
                {/if}
              </span>
              {#if option.description}
                <span class="choice-description">{option.description}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <form
        class="answer-form"
        onsubmit={(event) => {
          event.preventDefault();
          submitAnswer(draft);
        }}
      >
        <input
          type="text"
          bind:value={draft}
          placeholder="Your answer"
          aria-label="Your answer"
          data-testid="answer-input"
        />
        <button type="submit" data-testid="submit-answer" disabled={draft.trim().length === 0}>
          Submit answer
        </button>
      </form>
    </section>
  {/if}

  {#if skillsOpen}
    <div
      class="overlay"
      role="presentation"
      onclick={(event) => {
        if (event.target === event.currentTarget) skillsOpen = false;
      }}
    >
      <div
        class="overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skills-overlay-title"
        data-testid="skills-overlay"
      >
        <div class="overlay-heading">
          <h2 id="skills-overlay-title">
            Skills <span class="skills-count" data-testid="skills-count">{skills.length}</span>
          </h2>
          <button
            type="button"
            class="start-button overlay-close"
            data-testid="close-skills"
            use:focusOnMount
            onclick={() => (skillsOpen = false)}
          >
            Close
          </button>
        </div>

        <ul class="skill-list">
          {#each skills as skill (skill.name)}
            <li class="skill" data-testid="skill" data-name={skill.name}>
              <span class="skill-name">{skill.name}</span>
              <p class="skill-description">{skill.description}</p>
            </li>
          {/each}
        </ul>
        {#if contradictions.length === 0}
          <p class="skills-contradictions" data-testid="skills-no-contradictions">
            No contradictions
          </p>
        {:else}
          <ul class="skills-contradictions" data-testid="skills-contradictions">
            {#each contradictions as contradiction (`${contradiction.skills[0]}:${contradiction.skills[1]}`)}
              <li>
                {contradiction.skills[0]} and {contradiction.skills[1]}:
                “{contradiction.directives[0]}” vs “{contradiction.directives[1]}”
              </li>
            {/each}
          </ul>
        {/if}

        <div class="overlay-actions">
          <button
            type="button"
            class="start-button prepare-skills"
            data-testid="prepare-skills-overlay"
            disabled={prepareDisabled}
            onclick={prepareSkills}
          >
            Prepare skills again
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if adrsOpen}
    <div
      class="overlay"
      role="presentation"
      onclick={(event) => {
        if (event.target === event.currentTarget) adrsOpen = false;
      }}
    >
      <div
        class="overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="adrs-overlay-title"
        data-testid="adrs-overlay"
      >
        <div class="overlay-heading">
          <h2 id="adrs-overlay-title">ADRs</h2>
          <button
            type="button"
            class="start-button overlay-close"
            data-testid="close-adrs"
            use:focusOnMount
            onclick={() => (adrsOpen = false)}
          >
            Close
          </button>
        </div>

        {#if records.length === 0}
          <p class="empty">No records found.</p>
        {:else}
          <ul class="records">
            {#each records as record (record.file)}
              <li
                class="record"
                class:pending={record.pending}
                class:resolved={!record.pending}
                class:active={runFile === record.file}
                data-testid="record"
                data-file={record.file}
                data-pending={record.pending}
                data-next={next === record.file}
                data-active={runFile === record.file}
              >
                <div class="record-heading">
                  <details class="record-details">
                    <summary class="record-summary">
                      <span class="record-title">{record.title}</span>
                    </summary>
                    <p class="record-decision" data-testid="record-summary">
                      {record.summary || "No decision summary recorded."}
                    </p>
                  </details>
                  <div class="record-actions">
                    {#if next === record.file}
                      <span
                        class="next-marker"
                        data-testid="next-marker"
                        aria-label="Next record to resolve"
                      >
                        Next
                      </span>
                    {/if}
                    {#if record.pending}
                      <button
                        type="button"
                        class="start-button record-start"
                        data-testid="start"
                        data-file={record.file}
                        title={runStartTitle}
                        disabled={runStartDisabled}
                        onclick={() => {
                          adrsOpen = false;
                          start(record.file === next ? undefined : record.file);
                        }}
                      >
                        Start
                      </button>
                    {/if}
                  </div>
                </div>

                <div class="meta">
                  <span class="status">{record.status || "Unknown"}</span>
                  <span class="state">{record.pending ? "Pending" : "Resolved"}</span>
                  <code>{record.file}</code>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}
  </div>

  <div
    class="mode-view"
    id="flow-view"
    role="tabpanel"
    aria-labelledby="mode-flow-tab"
    bind:this={flowViewEl}
    hidden={mode !== "flow"}
    onfocusin={(event) => rememberFocus("flow", event)}
  >
    <FlowMode send={sendCommand} bind:this={flowComponent} />
  </div>
</main>

<FeedbackOverlay />
