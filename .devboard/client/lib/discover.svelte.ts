import { connection, type ConnectionStore } from "./connection.svelte";
import { dependencyName } from "../../lib/dependencies.ts";
import {
  commandAlias,
  conceptSignificance,
  conceptUsage,
  filterContexts,
  glossaryHasSignificance,
  scalarText,
  sectionLeaf,
  SIGNIFICANCE_FLOOR,
} from "./discover-format";
import type {
  ConceptSignificance,
  ConceptUsage,
  Contribution,
  DiscoverAgentPrompt,
  DiscoverAgentState,
  DiscoverSkill,
  DiscoverStatePayload,
  DiscoverTarget,
  Freshness,
  Glossary,
  GlossarySignificance,
  GlossaryUsage,
  RetainedRemoteProject,
  RunQuestion,
  RunQuestionOption,
} from "./types";

type Message = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendLine(lines: string[], text: string, append: boolean): string[] {
  if (append && lines.length > 0) {
    return [...lines.slice(0, -1), (lines[lines.length - 1] ?? "") + text];
  }
  return [...lines, text];
}

export class DiscoverStore {
  /** The socket every command goes through; a test supplies its own. */
  private readonly socket: ConnectionStore;

  constructor(socket: ConnectionStore = connection) {
    this.socket = socket;
  }

  /** Reads the Discover workspace; the poll repeats it once a second. */
  request(): void {
    this.socket.send({ type: "getDiscover" }, "refresh");
  }

  /**
   * Clears the operation flags before a reconnect's state requests are sent.
   * A stop frame missed during the disconnect otherwise leaves the tab busy,
   * while the server's replayed snapshot restores a run that is still active.
   */
  resetActiveOperations(): void {
    this.active = false;
    this.starting = false;
    this.activeAgent = null;
    this.runningAll = false;
    this.allFailed = null;
    this.runId = null;
    this.startedRunId = null;
    this.startedAt = null;
    this.question = null;
    this.answerDraft = "";
    this.interrupted = false;
  }

  state = $state<DiscoverStatePayload | null>(null);
  active = $state(false);
  /** The server's clone-to-first-run phase; the server refuses changes then. */
  starting = $state(false);
  /** The agent the active run belongs to. */
  activeAgent = $state<string | null>(null);
  runningAll = $state(false);
  /** The step a Run all sequence halted on, or null while it runs or succeeds. */
  allFailed = $state<string | null>(null);
  runId = $state<string | null>(null);
  /**
   * The run the last `discoverStarted` frame announced. The workspace poll
   * replays that frame once a second while a run exists, so a frame naming
   * this run is a replay of a transition this page already applied.
   */
  private startedRunId: string | null = null;
  startedAt = $state<string | null>(null);
  /** The active agent's lines, shown by the shared run tag. */
  activity = $state<string[]>([]);
  question = $state<RunQuestion | null>(null);
  /** Every agent's own pending question. */
  agentQuestions = $state<Record<string, RunQuestion | null>>({});
  /** Every card's prompt, from the connect replay and each later read. */
  promptStates = $state<Record<string, DiscoverAgentPrompt>>({});
  error = $state<string | null>(null);
  /** The agent whose run failed; its own card carries that failure. */
  errorAgent = $state<string | null>(null);
  warnings = $state<string[]>([]);
  interrupted = $state(false);
  answerDraft = $state("");
  glossarySearch = $state("");
  /** The URL field of the source-checkout-only remote target strip. */
  remoteUrl = $state("");
  /** Significance floor a listed term needs to stay listed. */
  glossaryThreshold = $state(SIGNIFICANCE_FLOOR);
  /** Hide scored terms below the floor; on by default. */
  glossarySignificantOnly = $state(true);

  get remoteAvailable(): boolean {
    return this.state?.remoteAvailable === true;
  }

  get target(): DiscoverTarget {
    return this.state?.target ?? { kind: "host" };
  }

  /** The repository identity the head shows: `owner/name` when it is known. */
  get repository(): string | null {
    if (typeof this.state?.repository === "string" && this.state.repository.length > 0) {
      return this.state.repository;
    }
    const target = this.target;
    return target.kind === "remote" ? `${target.owner}/${target.repo}` : null;
  }

  get remoteTarget(): Extract<DiscoverTarget, { kind: "remote" }> | null {
    const target = this.target;
    return target.kind === "remote" ? target : null;
  }

  /** Every retained remote project, newest completed discovery first. */
  get retained(): RetainedRemoteProject[] {
    return Array.isArray(this.state?.retained) ? this.state.retained : [];
  }

  /** True while the remote target cannot be changed without a refusal. */
  get remoteChangeDisabled(): boolean {
    return this.remoteChangeTitle !== undefined;
  }

  get remoteChangeTitle(): string | undefined {
    if (!this.socket.open) return "Not connected";
    if (this.cloning !== null) return "A repository clone is running";
    if (this.runningAll) return "Run all is running";
    if (this.active || this.starting) return "A Discover run is active";
    return this.busy ?? undefined;
  }

  get cloning(): { url: string } | null {
    return this.state?.cloning ?? null;
  }

  /** The live checkout's project while it differs from the selected target. */
  get running(): { url: string } | null {
    return this.state?.running ?? null;
  }

  /**
   * The URL of the project the page shows: an in-flight clone wins, then the
   * live checkout, then the selected target. The remote strip never reads it;
   * that strip shows the selected target alone.
   */
  get shownUrl(): string | null {
    return this.running?.url ?? this.cloning?.url ?? this.remoteTarget?.url ?? null;
  }

  /** The remote start control's disabled state; its title names the reason. */
  get remoteStartDisabled(): boolean {
    return this.remoteStartTitle !== undefined;
  }

  get remoteStartTitle(): string | undefined {
    if (!this.socket.open) return "Not connected";
    if (this.cloning !== null) return "A repository clone is running";
    if (this.active) return "A Discover run is active";
    if (this.busy !== null) return this.busy;
    if (this.remoteUrl.trim().length === 0) return "Enter a GitHub repository URL";
    return undefined;
  }

  /** The seven discovery cards, in sidebar order. */
  get agents(): DiscoverAgentState[] {
    return Array.isArray(this.state?.agents) ? this.state.agents : [];
  }

  agent(id: string): DiscoverAgentState | null {
    return this.agents.find((entry) => entry?.id === id) ?? null;
  }

  agentPrompt(id: string): DiscoverAgentPrompt | null {
    return this.promptStates[id] ?? this.agent(id)?.prompt ?? null;
  }

  agentQuestionOf(id: string): RunQuestion | null {
    return this.agentQuestions[id] ?? null;
  }

  /** The first reason this card cannot start, or undefined when it can. */
  agentStartTitle(id: string): string | undefined {
    if (!this.socket.open) return "Not connected";
    if (this.runningAll) return "Run all is running";
    if (this.active) {
      if (this.activeAgent === id) return `${this.agent(id)?.label ?? id} is running`;
      return `${this.agent(this.activeAgent ?? "")?.label ?? "Another discovery agent"} is running`;
    }
    return this.busy ?? undefined;
  }

  agentStartDisabled(id: string): boolean {
    return this.agentStartTitle(id) !== undefined;
  }

  get busy(): string | null {
    return this.state?.busy ?? null;
  }

  get stale(): boolean {
    return this.state?.stale === true;
  }

  get freshness(): Freshness | null {
    return this.state?.freshness ?? null;
  }

  get sheet(): Record<string, unknown> | null {
    return this.state?.sheet ?? null;
  }

  get repositories(): Record<string, string> {
    const value = this.state?.dependencyRepositories;
    return typeof value === "object" && value !== null ? value : {};
  }

  /** The repository URL an installed package behind this entry declares. */
  repositoryLink(line: string): string | null {
    const name = dependencyName(line);
    if (name.length === 0) return null;
    return this.repositories[name] ?? this.repositories[name.toLowerCase()] ?? null;
  }

  /**
   * The server's VS Code handoff for one Overview path reference, or null when
   * the value stays plain text: a missing path, an absolute or outside-checkout
   * path, or any reference of a retained remote target.
   */
  pathLink(reference: string): string | null {
    const href = this.state?.overviewLinks?.[reference.trim()];
    return typeof href === "string" && href.startsWith("vscode://file/") ? href : null;
  }

  get contribution(): Contribution | null {
    return this.state?.contribution ?? null;
  }

  get hasArtifacts(): boolean {
    return (
      this.sheet !== null ||
      this.contexts.length > 0 ||
      this.skills.length > 0 ||
      this.contribution !== null
    );
  }

  get displayError(): string | null {
    return this.error ?? this.state?.error ?? null;
  }

  /**
   * The failure the shared notice stack may show. A run failure names its
   * agent and belongs on that agent's own card, so the stack carries only a
   * failure that names no agent.
   */
  get noticeError(): string | null {
    return this.error !== null && this.errorAgent === null
      ? this.error
      : (this.state?.error ?? null);
  }

  get displayedWarnings(): string[] {
    return this.warnings.length > 0 ? this.warnings : (this.state?.warnings ?? []);
  }

  get contexts(): Glossary[] {
    return Array.isArray(this.state?.glossaries) ? this.state.glossaries : [];
  }

  get glossaryUsage(): GlossaryUsage {
    const value = this.state?.glossaryUsage;
    return typeof value === "object" && value !== null ? value : {};
  }

  get glossarySignificance(): GlossarySignificance {
    const value = this.state?.glossarySignificance;
    return typeof value === "object" && value !== null ? value : {};
  }

  /** True when the published glossary carries at least one crawl score. */
  get glossaryHasScores(): boolean {
    return glossaryHasSignificance(this.contexts, this.glossarySignificance);
  }

  usageFor(context: string, id: string): ConceptUsage {
    return conceptUsage(this.glossaryUsage, context, id);
  }

  significanceFor(context: string, id: string): ConceptSignificance | null {
    return conceptSignificance(this.glossarySignificance, context, id) ?? null;
  }

  get filteredContexts(): Glossary[] {
    return filterContexts(this.contexts, {
      search: this.glossarySearch,
      significantOnly: this.glossarySignificantOnly,
      floor: this.glossaryThreshold,
      significance: this.glossarySignificance,
    });
  }

  /** The invocation that runs the whole suite, preferring the manifest's own alias. */
  get testCommand(): string {
    const leaf = sectionLeaf(this.sheet?.commands, "test");
    if (leaf === undefined || leaf.confidence === "unknown") return "";
    return this.aliasFor(scalarText(leaf.value));
  }

  /** The command to show for a recorded command: its declared alias when one exists. */
  aliasFor(command: string): string {
    return commandAlias(this.state?.commandAliases, command);
  }

  /** The Overview run control's disabled reason; a single run disables it too. */
  get startTitle(): string | undefined {
    if (!this.socket.open) return "Not connected";
    if (this.runningAll) return "Run all is running";
    if (this.active) {
      return `${this.agent(this.activeAgent ?? "")?.label ?? "A discovery agent"} is running`;
    }
    return this.busy ?? undefined;
  }

  get startDisabled(): boolean {
    return this.startTitle !== undefined;
  }

  get skills(): DiscoverSkill[] {
    return Array.isArray(this.state?.skills) ? this.state.skills : [];
  }

  skill(name: string): DiscoverSkill | null {
    return this.skills.find((skill) => skill.name === name) ?? null;
  }

  /** The live skill file's bytes, or its generated baseline while it is missing. */
  skillText(name: string): string {
    const entry = this.skill(name);
    return entry?.live ?? entry?.baseline ?? "";
  }

  /** Runs the six agents in their fixed order from the Overview page. */
  start(): void {
    if (this.startDisabled) return;
    this.socket.send({ type: "discoverProject" });
  }

  /** Starts exactly one agent; another live run refuses it at the server too. */
  startAgent(id: string): void {
    if (this.agentStartTitle(id) !== undefined) return;
    this.socket.send({ type: "discoverAgent", agent: id });
  }

  /** Sends exactly one `discoverRemote` for the trimmed URL. */
  startRemote(): void {
    const url = this.remoteUrl.trim();
    if (url.length === 0 || this.remoteStartTitle !== undefined) return;
    this.remoteUrl = "";
    this.socket.send({ type: "discoverRemote", url });
  }

  /** Returns to this checkout's own artifacts; retained projects are kept. */
  clearRemote(): void {
    this.remoteUrl = "";
    this.socket.send({ type: "clearDiscoverRemote" });
  }

  /** Switches to a retained project; never clones or crawls. */
  switchRemote(url: string): void {
    if (url.length === 0 || url === this.remoteTarget?.url) return;
    this.socket.send({ type: "switchDiscoverRemote", url });
  }

  /** Deletes one retained project; the host target returns when it was active. */
  removeRemote(url: string): void {
    if (url.length === 0) return;
    this.socket.send({ type: "removeDiscoverRemote", url });
  }

  stop(): void {
    this.socket.send({ type: "stopDiscover" });
  }

  answer(value: string): void {
    if (this.question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const id = this.question.id;
    this.question = null;
    this.clearAgentQuestion(id);
    this.answerDraft = "";
    this.socket.send({ type: "answerDiscover", id, value: trimmed });
  }

  /**
   * Drops every per-agent entry for one answered question, so no card keeps
   * rendering dead choices after the global question is gone.
   */
  private clearAgentQuestion(id: string | number): void {
    for (const [agent, question] of Object.entries(this.agentQuestions)) {
      if (question !== null && question.id === id) this.agentQuestions[agent] = null;
    }
  }

  setGlossarySearch(value: string): void {
    this.glossarySearch = value;
  }

  setGlossaryThreshold(value: number): void {
    if (!Number.isFinite(value)) return;
    this.glossaryThreshold = Math.min(100, Math.max(0, Math.round(value)));
  }

  setGlossarySignificantOnly(value: boolean): void {
    this.glossarySignificantOnly = value;
  }

  /** Restores the default view: no search, the floor, and the filter on. */
  resetGlossaryFilters(): void {
    this.glossarySearch = "";
    this.glossaryThreshold = SIGNIFICANCE_FLOOR;
    this.glossarySignificantOnly = true;
  }

  private applySnapshot(payload: DiscoverStatePayload): void {
    this.state = payload;
    this.glossaryThreshold = Math.min(100, Math.max(0, Math.round(this.glossaryThreshold)));
    this.active = payload.active === true;
    this.starting = payload.starting === true;
    this.activeAgent =
      typeof payload.activeAgent === "string" ? payload.activeAgent : null;
    this.runningAll = payload.runningAll === true;
    this.allFailed = typeof payload.allFailed === "string" ? payload.allFailed : null;
    if (!this.active) this.agentQuestions = {};
    if (Array.isArray(payload.agents)) {
      const prompts = { ...this.promptStates };
      for (const entry of payload.agents) {
        if (entry?.prompt !== null && entry?.prompt !== undefined) {
          prompts[entry.id] = entry.prompt;
        }
      }
      this.promptStates = prompts;
    }
    this.runId = typeof payload.runId === "string" ? payload.runId : null;
    this.startedAt = typeof payload.startedAt === "string" ? payload.startedAt : null;
    this.warnings = Array.isArray(payload.warnings)
      ? payload.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
    this.interrupted = payload.interrupted === true;
  }

  handleEvent(message: Message): void {
    const type = message.type;

    if (type === "discoverState" && isObject(message.state)) {
      this.applySnapshot(message.state as unknown as DiscoverStatePayload);
      return;
    }
    if (type === "discoverStarted") {
      const agent = typeof message.agent === "string" ? message.agent : null;
      const runId = typeof message.runId === "string" ? message.runId : null;
      const replayed = runId !== null && runId === this.startedRunId;
      this.startedRunId = runId;
      this.active = true;
      this.activeAgent = agent;
      if (runId !== null) this.runId = runId;
      this.startedAt = typeof message.startedAt === "string" ? message.startedAt : null;
      // The replay resends the run's complete activity log, so the log is
      // rebuilt from it either way; only a transition clears the answer.
      this.activity = [];
      if (replayed) return;
      if (agent !== null) {
        this.agentQuestions[agent] = null;
      }
      this.question = null;
      this.answerDraft = "";
      this.error = null;
      this.errorAgent = null;
      return;
    }
    if (type === "discoverActivity" && typeof message.text === "string") {
      const agent = typeof message.agent === "string" ? message.agent : null;
      if (agent === null || agent === this.activeAgent) {
        this.activity = appendLine(this.activity, message.text, message.append === true);
      }
      return;
    }
    if (
      type === "discoverQuestion" &&
      (typeof message.id === "string" || typeof message.id === "number") &&
      typeof message.message === "string" &&
      Array.isArray(message.options)
    ) {
      const question: RunQuestion = {
        id: message.id,
        message: message.message,
        options: message.options as RunQuestionOption[],
      };
      const agent = typeof message.agent === "string" ? message.agent : null;
      if (agent !== null) this.agentQuestions[agent] = question;
      if (agent === null || agent === this.activeAgent) {
        // A replayed frame repeats the question this page already shows; only
        // a different decision discards the answer typed for it.
        const changed = this.question === null || this.question.id !== question.id;
        this.question = question;
        if (changed) this.answerDraft = "";
      }
      return;
    }
    if (type === "discoverStopped") {
      this.active = false;
      this.activeAgent = null;
      this.startedRunId = null;
      this.question = null;
      this.agentQuestions = {};
      this.answerDraft = "";
      return;
    }
    if (type === "discoverPromptState" && typeof message.agent === "string") {
      const prompt = message.prompt as DiscoverAgentPrompt | null;
      if (prompt !== null && typeof prompt === "object") {
        this.promptStates[message.agent] = prompt;
      }
      return;
    }
    if (type === "discoverError" && typeof message.message === "string") {
      this.error = message.message;
      this.errorAgent = typeof message.agent === "string" ? message.agent : null;
    }
  }
}

export const discover = new DiscoverStore();

