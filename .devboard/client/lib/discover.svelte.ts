import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import { filterContexts, scalarText, sectionLeaf, TABS } from "./discover-format";
import type {
  DiscoverSkill,
  DiscoverStatePayload,
  Freshness,
  Glossary,
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

  drafts = $state<Record<string, string>>({});
  dirty = $state<Record<string, boolean>>({});

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

  get filteredContexts(): Glossary[] {
    return filterContexts(this.contexts, this.glossarySearch);
  }

  get testCommand(): string {
    const leaf = sectionLeaf(this.sheet?.commands, "test");
    return leaf === undefined || leaf.confidence === "unknown" ? "" : scalarText(leaf.value);
  }

  get startDisabled(): boolean {
    return !connection.open || this.active || this.busy !== null;
  }

  get startTitle(): string | undefined {
    if (!connection.open) return "Not connected";
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

  skillStateLabel(value: string): string {
    return value === "generated" ? "Generated" : value === "edited" ? "Edited" : "Missing";
  }

  tab(id: string) {
    return TABS.find((tab) => tab.id === id) ?? null;
  }

  start(): void {
    connection.send({ type: "discoverProject" });
  }

  stop(): void {
    connection.send({ type: "stopDiscover" });
  }

  answer(value: string): void {
    if (this.question === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const id = this.question.id;
    this.question = null;
    this.answerDraft = "";
    connection.send({ type: "answerDiscover", id, value: trimmed });
  }

  updateDraft(name: string, text: string): void {
    this.drafts = { ...this.drafts, [name]: text };
    const live = this.skill(name)?.live ?? this.skill(name)?.baseline ?? "";
    this.dirty = { ...this.dirty, [name]: text !== live };
  }

  saveSkill(name: string): void {
    connection.send({ type: "saveDiscoverSkill", name, text: this.skillDraft(name) });
  }

  restoreSkill(name: string): void {
    const baseline = this.skill(name)?.baseline ?? null;
    if (baseline !== null) {
      this.drafts = { ...this.drafts, [name]: baseline };
      this.dirty = { ...this.dirty, [name]: false };
    }
    connection.send({ type: "restoreDiscoverSkill", name });
  }

  discardDraft(name: string): void {
    const entry = this.skill(name);
    const live = entry?.live ?? entry?.baseline ?? "";
    this.drafts = { ...this.drafts, [name]: live };
    this.dirty = { ...this.dirty, [name]: false };
  }

  setGlossarySearch(value: string): void {
    this.glossarySearch = value;
  }

  private syncDrafts(payload: DiscoverStatePayload): void {
    const skills = Array.isArray(payload.skills) ? payload.skills : [];
    for (const skill of skills) {
      if (typeof skill?.name !== "string") continue;
      const live = skill.live ?? skill.baseline ?? "";
      if (this.dirty[skill.name] !== true) {
        this.drafts = { ...this.drafts, [skill.name]: live };
      } else if (this.drafts[skill.name] === live) {
        this.dirty = { ...this.dirty, [skill.name]: false };
      }
    }
  }

  private applySnapshot(payload: DiscoverStatePayload): void {
    this.state = payload;
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
      this.transition = "Discover run started.";
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
        this.transition = "Discover run completed.";
      } else if (typeof message.reason === "string" && message.reason.length > 0) {
        this.transition = `Discover run stopped: ${message.reason}`;
      } else {
        this.transition = "Discover run stopped.";
      }
      return;
    }
    if (type === "discoverError" && typeof message.message === "string") {
      this.error = message.message;
      notifications.push("error", message.message);
    }
  }
}

export const discover = new DiscoverStore();

