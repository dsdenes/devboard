import { connection, type ConnectionStore } from "./connection.svelte";
import { dependencyName } from "../../lib/dependencies.ts";
import { notifications } from "./notifications.svelte";
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

/** The frame field naming the Discover target a skill edit belongs to. */
type SkillSaveTarget =
  | { kind: "host" }
  | { kind: "remote"; owner: string; repo: string };

interface SkillDraftScope {
  drafts: Record<string, string>;
  dirty: Record<string, boolean>;
}

const EMPTY_DRAFT_SCOPE: SkillDraftScope = { drafts: {}, dirty: {} };

/**
 * The identity drafts are scoped to. Every project shares the five fixed skill
 * names, so the target — not the name — decides which unsaved text belongs to
 * which project.
 */
function draftTargetKey(target: DiscoverTarget | null | undefined): string {
  if (target?.kind === "remote") {
    return `remote:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
  }
  return "host";
}

/** The minimal target descriptor `saveDiscoverSkill` carries to the server. */
function saveTargetOf(target: DiscoverTarget): SkillSaveTarget {
  if (target.kind === "remote") {
    return { kind: "remote", owner: target.owner, repo: target.repo };
  }
  return { kind: "host" };
}

export class DiscoverStore {
  /** The socket every command goes through; a test supplies its own. */
  private readonly socket: ConnectionStore;

  constructor(socket: ConnectionStore = connection) {
    this.socket = socket;
  }

  /**
   * Clears the operation flags before a reconnect's state requests are sent.
   * A stop frame missed during the disconnect otherwise leaves the tab busy,
   * while the server's replayed snapshot restores a run that is still active.
   */
  resetActiveOperations(): void {
    this.active = false;
    this.runId = null;
    this.startedAt = null;
    this.question = null;
    this.answerDraft = "";
    this.interrupted = false;
    this.transition = null;
  }

  state = $state<DiscoverStatePayload | null>(null);
  active = $state(false);
  runId = $state<string | null>(null);
  startedAt = $state<string | null>(null);
  activity = $state<string[]>([]);
  question = $state<RunQuestion | null>(null);
  error = $state<string | null>(null);
  warnings = $state<string[]>([]);
  interrupted = $state(false);
  transition = $state<string | null>(null);
  answerDraft = $state("");
  glossarySearch = $state("");
  /** The URL field of the source-checkout-only remote target strip. */
  remoteUrl = $state("");
  /** Significance floor a listed term needs to stay listed. */
  glossaryThreshold = $state(SIGNIFICANCE_FLOOR);
  /** Hide scored terms below the floor; on by default. */
  glossarySignificantOnly = $state(true);

  /** Unsaved skill text per target identity; a switch never leaks across targets. */
  private draftScopes = $state<Record<string, SkillDraftScope>>({});

  get drafts(): Record<string, string> {
    return this.draftScopeOf(draftTargetKey(this.state?.target)).drafts;
  }

  get dirty(): Record<string, boolean> {
    return this.draftScopeOf(draftTargetKey(this.state?.target)).dirty;
  }

  private draftScopeOf(key: string): SkillDraftScope {
    return this.draftScopes[key] ?? EMPTY_DRAFT_SCOPE;
  }

  private writeDraftScope(key: string, scope: SkillDraftScope): void {
    this.draftScopes = { ...this.draftScopes, [key]: scope };
  }

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
    if (this.active) return "A Discover run is active";
    return this.busy ?? undefined;
  }

  get cloning(): { url: string } | null {
    return this.state?.cloning ?? null;
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

  get hasArtifacts(): boolean {
    return this.sheet !== null;
  }

  get displayError(): string | null {
    return this.error ?? this.state?.error ?? null;
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

  get startDisabled(): boolean {
    return !this.socket.open || this.active || this.busy !== null;
  }

  get startTitle(): string | undefined {
    if (!this.socket.open) return "Not connected";
    if (this.active) return "A Discover run is active";
    return this.busy ?? undefined;
  }

  get skills(): DiscoverSkill[] {
    return Array.isArray(this.state?.skills) ? this.state.skills : [];
  }

  skill(name: string): DiscoverSkill | null {
    return this.skills.find((skill) => skill.name === name) ?? null;
  }

  skillDraft(name: string): string {
    const stored = this.drafts[name];
    if (stored !== undefined) return stored;
    const entry = this.skill(name);
    return entry?.live ?? entry?.baseline ?? "";
  }

  skillDirty(name: string): boolean {
    return this.dirty[name] === true;
  }

  start(): void {
    this.socket.send({ type: "discoverProject" });
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
    this.answerDraft = "";
    this.socket.send({ type: "answerDiscover", id, value: trimmed });
  }

  updateDraft(name: string, text: string): void {
    const key = draftTargetKey(this.state?.target);
    const scope = this.draftScopeOf(key);
    const live = this.skill(name)?.live ?? this.skill(name)?.baseline ?? "";
    this.writeDraftScope(key, {
      drafts: { ...scope.drafts, [name]: text },
      dirty: { ...scope.dirty, [name]: text !== live },
    });
  }

  saveSkill(name: string): void {
    this.socket.send({
      type: "saveDiscoverSkill",
      name,
      text: this.skillDraft(name),
      target: saveTargetOf(this.target),
    });
  }

  restoreSkill(name: string): void {
    const baseline = this.skill(name)?.baseline ?? null;
    if (baseline !== null) {
      const key = draftTargetKey(this.state?.target);
      const scope = this.draftScopeOf(key);
      this.writeDraftScope(key, {
        drafts: { ...scope.drafts, [name]: baseline },
        dirty: { ...scope.dirty, [name]: false },
      });
    }
    this.socket.send({ type: "restoreDiscoverSkill", name });
  }

  discardDraft(name: string): void {
    const entry = this.skill(name);
    const live = entry?.live ?? entry?.baseline ?? "";
    const key = draftTargetKey(this.state?.target);
    const scope = this.draftScopeOf(key);
    this.writeDraftScope(key, {
      drafts: { ...scope.drafts, [name]: live },
      dirty: { ...scope.dirty, [name]: false },
    });
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

  private syncDrafts(payload: DiscoverStatePayload): void {
    const skills = Array.isArray(payload.skills) ? payload.skills : [];
    const key = draftTargetKey(payload.target);
    const scope = this.draftScopeOf(key);
    let drafts = scope.drafts;
    let dirty = scope.dirty;
    for (const skill of skills) {
      if (typeof skill?.name !== "string") continue;
      const live = skill.live ?? skill.baseline ?? "";
      if (dirty[skill.name] !== true) {
        drafts = { ...drafts, [skill.name]: live };
      } else if (drafts[skill.name] === live) {
        dirty = { ...dirty, [skill.name]: false };
      }
    }
    if (drafts !== scope.drafts || dirty !== scope.dirty) {
      this.writeDraftScope(key, { drafts, dirty });
    }
  }

  private applySnapshot(payload: DiscoverStatePayload): void {
    this.state = payload;
    this.glossaryThreshold = Math.min(100, Math.max(0, Math.round(this.glossaryThreshold)));
    this.active = payload.active === true;
    this.runId = typeof payload.runId === "string" ? payload.runId : null;
    this.startedAt = typeof payload.startedAt === "string" ? payload.startedAt : null;
    this.warnings = Array.isArray(payload.warnings)
      ? payload.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
    this.interrupted = payload.interrupted === true;
    this.syncDrafts(payload);
  }

  handleEvent(message: Message): void {
    const type = message.type;

    if (type === "discoverState" && isObject(message.state)) {
      this.applySnapshot(message.state as unknown as DiscoverStatePayload);
      return;
    }
    if (type === "discoverStarted") {
      this.active = true;
      if (typeof message.runId === "string") this.runId = message.runId;
      this.startedAt = typeof message.startedAt === "string" ? message.startedAt : null;
      this.activity = [];
      this.question = null;
      this.answerDraft = "";
      this.error = null;
      this.transition = null;
      return;
    }
    if (type === "discoverActivity" && typeof message.text === "string") {
      this.activity = appendLine(this.activity, message.text, message.append === true);
      return;
    }
    if (
      type === "discoverQuestion" &&
      (typeof message.id === "string" || typeof message.id === "number") &&
      typeof message.message === "string" &&
      Array.isArray(message.options)
    ) {
      this.question = {
        id: message.id,
        message: message.message,
        options: message.options as RunQuestionOption[],
      };
      this.answerDraft = "";
      return;
    }
    if (type === "discoverStopped") {
      this.active = false;
      this.question = null;
      this.answerDraft = "";
      if (message.completed === true) {
        this.transition = null;
      } else if (typeof message.reason === "string" && message.reason.length > 0) {
        this.transition = `Discover run stopped: ${message.reason}`;
      } else {
        this.transition = "Discover run stopped.";
      }
      return;
    }
    if (type === "discoverError" && typeof message.message === "string") {
      this.error = message.message;
      notifications.push("Discover", "error", message.message);
    }
  }
}

export const discover = new DiscoverStore();

