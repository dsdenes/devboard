import { connection } from "./connection.svelte";
import { slowUiAction } from "./slow-ui-action";
import { GOAL_PROPOSALS_ENDPOINT } from "../../lib/endpoints.ts";
import { draftPathFromHref } from "../../lib/goal-proposals.ts";
import type {
  GoalDraftDetail,
  GoalDraftRun,
  GoalDraftStatus,
  GoalDraftSummary,
} from "./types";

export const DRAFT_PATH_KEY = "devboard.issues.draft.v1";
export const DRAFT_PAGE_KEY = "devboard.issues.draftsPage.v1";

export function markDraftsPage(open: boolean): void {
  try {
    if (open) localStorage.setItem(DRAFT_PAGE_KEY, "1");
    else localStorage.removeItem(DRAFT_PAGE_KEY);
  } catch {
    // Storage may be unavailable; the current session still works.
  }
}

export function draftsPageWasOpen(): boolean {
  try {
    return localStorage.getItem(DRAFT_PAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDraftPath(): string | null {
  try {
    const value = localStorage.getItem(DRAFT_PATH_KEY);
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

function writeDraftPath(path: string | null): void {
  try {
    if (path === null) localStorage.removeItem(DRAFT_PATH_KEY);
    else localStorage.setItem(DRAFT_PATH_KEY, path);
  } catch {
    // Storage may be unavailable; the selection then lasts the session only.
  }
}

/**
 * The goal-proposal draft state: the list under `.devboard/goal-proposals/`,
 * the selected draft, one elaboration run per path, and the New goal popover.
 * The dashboard owns file writes and run persistence; this store sends the
 * existing frames and replays `issuesDraft*` frames on connect.
 */
export class GoalDraftsStore {
  drafts = $state<GoalDraftSummary[]>([]);
  /** One elaboration run per draft path; a path with no entry is idle. */
  draftRuns = $state<Record<string, GoalDraftRun>>({});
  draft = $state<GoalDraftDetail | null>(null);
  draftPath = $state<string | null>(readDraftPath());
  /** The detail response is only accepted for the path last requested. */
  private draftRequest: string | null = null;
  draftErrors = $state<Record<string, string>>({});
  /** The New goal popover's open state and its in-flight submission. */
  draftCreateOpen = $state(false);
  draftCreating = $state(false);
  draftCreateError = $state<string | null>(null);
  /**
   * The path just created. A list request sent before the write can answer
   * after the selection moves, so it must not clear that selection until a
   * list has confirmed the path or its run has ended.
   */
  private pendingCreatedPath: string | null = null;

  draftRunFor(path: string | null): GoalDraftRun | null {
    return path === null ? null : (this.draftRuns[path] ?? null);
  }

  draftRunning(path: string | null): boolean {
    return this.draftRunFor(path)?.status === "running";
  }

  draftWaiting(path: string | null): boolean {
    return this.draftRunFor(path)?.question !== null &&
      this.draftRunFor(path)?.question !== undefined;
  }

  draftState(path: string | null): GoalDraftStatus {
    return this.draftRunFor(path)?.status ?? "idle";
  }

  get draftStatus(): string {
    return this.draftState(this.draftPath);
  }

  /** The stated reason this draft's own start control is disabled, or null. */
  draftStartBlocker(path: string): string | null {
    return this.draftRunning(path) ? "This draft is being elaborated." : null;
  }

  draftErrorFor(path: string | null): string | null {
    if (path === null) return null;
    return this.draftErrors[path] ?? this.draftRunFor(path)?.error ?? null;
  }

  refreshDrafts(): void {
    if (!connection.open) return;
    connection.send({ type: "getGoalDrafts" });
  }

  openDraft(path: string): void {
    this.draftPath = path;
    this.draftRequest = path;
    this.draft = null;
    delete this.draftErrors[path];
    writeDraftPath(path);
    if (connection.open) connection.send({ type: "getGoalDraft", path });
  }

  clearDraft(): void {
    this.draftPath = null;
    this.draftRequest = null;
    this.draft = null;
    writeDraftPath(null);
  }

  /**
   * Starts a draft and opens it, so the elaboration activity on screen belongs
   * to the goal the operator just started.
   */
  startDraft(path: string | null): void {
    if (path === null || this.draftRunning(path)) return;
    if (this.draftPath !== path) this.openDraft(path);
    delete this.draftErrors[path];
    connection.send({ type: "startGoalDraft", path });
  }

  stopDraft(path: string | null = this.draftPath): void {
    if (path === null || !this.draftRunning(path)) return;
    connection.send({ type: "stopGoalDraft", path });
  }

  /**
   * Asks the server to remove one draft from `.devboard/goal-proposals/`. The
   * row leaves only when the server's authoritative list arrives, so a refusal
   * (a live elaboration, a missing file) leaves the draft in place and its
   * reason arrives as a server error frame.
   */
  deleteDraft(path: string): void {
    if (path.length === 0 || this.draftRunning(path)) return;
    connection.send({ type: "deleteGoalDraft", path });
  }

  /** Opens the New goal popover; opening it writes nothing. */
  beginDraftCreate(): void {
    this.draftCreateError = null;
    this.draftCreateOpen = true;
  }

  cancelDraftCreate(): void {
    if (this.draftCreating) return;
    this.draftCreateOpen = false;
    this.draftCreateError = null;
  }

  /**
   * Writes one context-free draft and starts its elaboration. There is no
   * concurrency cap, so another draft's run never prevents the new draft from
   * starting. A failed write keeps the popover open with the server's error
   * and starts nothing.
   */
  async createDraft(report: string): Promise<boolean> {
    if (report.trim().length === 0 || this.draftCreating) return false;
    this.draftCreating = true;
    this.draftCreateError = null;
    const action = slowUiAction.dispatchHttp(`POST ${GOAL_PROPOSALS_ENDPOINT}`);
    try {
      const response = await fetch(GOAL_PROPOSALS_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ report }),
      });
      action?.complete();
      const body = (await response.json().catch(() => null)) as {
        links?: { draft?: { href?: unknown } };
        detail?: unknown;
      } | null;
      const href = body?.links?.draft?.href;
      const path = typeof href === "string" ? draftPathFromHref(href) : null;
      if (!response.ok || path === null) {
        this.draftCreateError =
          typeof body?.detail === "string"
            ? body.detail
            : `The server refused the draft (${response.status}).`;
        return false;
      }
      this.draftCreateOpen = false;
      this.pendingCreatedPath = path;
      this.openDraft(path);
      this.refreshDrafts();
      this.startDraft(path);
      return true;
    } catch (error) {
      action?.complete();
      this.draftCreateError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.draftCreating = false;
    }
  }

  submitDraftAnswer(value: string): void {
    const path = this.draftPath;
    if (path === null) return;
    const question = this.draftRunFor(path)?.question ?? null;
    if (question === null || value.trim().length === 0) return;
    connection.send({ type: "answerGoalDraft", path, id: question.id, value: value.trim() });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "issuesDrafts" && Array.isArray(message.drafts)) {
      const drafts = (message.drafts as GoalDraftSummary[]).filter(
        (draft) => typeof draft?.path === "string" && typeof draft?.name === "string",
      );
      this.drafts = drafts.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      const known = new Set(drafts.map((draft) => draft.path));
      if (Array.isArray(message.runs)) {
        // A full replay is authoritative: a draft the server no longer reports
        // running must not keep a stale client state after a reconnect.
        const runs: Record<string, GoalDraftRun> = {};
        for (const value of message.runs) {
          if (!isObject(value) || typeof value.status !== "string" || typeof value.path !== "string") {
            continue;
          }
          const run = value as unknown as GoalDraftRun;
          const path = value.path;
          runs[path] = {
            ...run,
            path,
            activity: Array.isArray(run.activity) ? run.activity : [],
            question: (run.question ?? null) as GoalDraftRun["question"],
          };
        }
        this.draftRuns = runs;
      } else {
        // A refreshed list without runs keeps live runs and drops vanished ones.
        const runs: Record<string, GoalDraftRun> = {};
        for (const [path, run] of Object.entries(this.draftRuns)) {
          if (known.has(path) || run.status === "running") runs[path] = run;
        }
        this.draftRuns = runs;
      }
      for (const path of Object.keys(this.draftErrors)) {
        if (!known.has(path)) delete this.draftErrors[path];
      }
      const pending = this.pendingCreatedPath;
      if (pending !== null) {
        if (known.has(pending)) {
          this.pendingCreatedPath = null;
        } else if (
          this.draftRuns[pending] !== undefined &&
          this.draftRuns[pending]?.status !== "running"
        ) {
          // The draft finished and removed itself before any list confirmed it.
          this.pendingCreatedPath = null;
          this.clearDraft();
        }
      } else if (this.draftPath !== null && !known.has(this.draftPath)) {
        this.clearDraft();
      }
      return;
    }
    if (message.type === "issuesDraftState" && isObject(message.draft)) {
      const run = message.draft as unknown as GoalDraftRun;
      if (typeof run.status !== "string" || typeof run.path !== "string") return;
      this.draftRuns = {
        ...this.draftRuns,
        [run.path]: {
          ...run,
          activity: Array.isArray(run.activity) ? run.activity : [],
          question: (run.question ?? null) as GoalDraftRun["question"],
        },
      };
      if (run.status === "running") delete this.draftErrors[run.path];
      return;
    }
    if (message.type === "issuesDraftDetail" && isObject(message.draft)) {
      const draft = message.draft as unknown as GoalDraftDetail;
      if (typeof draft.path !== "string" || typeof draft.text !== "string") return;
      // A detail for a superseded selection must not replace the open draft.
      if (this.draftRequest !== null && draft.path !== this.draftRequest) return;
      this.draft = draft;
      this.draftPath = draft.path;
      writeDraftPath(draft.path);
      delete this.draftErrors[draft.path];
      return;
    }
    if (message.type === "issuesDraftError" && typeof message.message === "string") {
      const path = typeof message.path === "string" ? message.path : null;
      // A stored path whose draft is gone opens the list instead of an error.
      if (
        path === this.draftPath &&
        this.draft === null &&
        message.message.startsWith("No draft at")
      ) {
        this.clearDraft();
        return;
      }
      if (path !== null) this.draftErrors = { ...this.draftErrors, [path]: message.message };
      else if (this.draftPath !== null) {
        this.draftErrors = { ...this.draftErrors, [this.draftPath]: message.message };
      }
    }
  }
}

export const goalDrafts = new GoalDraftsStore();
