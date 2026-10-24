import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  FlowPrAdapter,
  ForgePrInput,
  ForgePrState,
  ForgeTarget,
} from "../forge-pr";

/**
 * A deterministic forge for Flow Mode's tests and browser verification.
 *
 * It records every operation and answers as a forge would, so a test can prove
 * the adapter's call sequence, the draft → live → merged transitions, and that
 * a failure keeps the session intact. It never contacts a network.
 */

export interface StubForgeOptions {
  /** Appended with one JSON line per operation. */
  logPath?: string;
  /** Message the matching operation throws instead of succeeding. */
  failCreate?: string;
  failReady?: string;
  failMerge?: string;
  /** Draft PR number the stub invents. */
  number?: number;
  /** URL base the stub invents; GitHub and GitLab spell the path differently. */
  baseUrl?: string;
}

export type StubForgeOperation =
  | "createDraft"
  | "update"
  | "markReady"
  | "merge"
  | "view"
  | "deleteRemoteBranch";

export interface StubForgeCall {
  op: StubForgeOperation;
  input?: unknown;
  number?: number;
  branch?: string;
}

export class StubForge implements FlowPrAdapter {
  readonly calls: StubForgeCall[] = [];
  readonly #options: StubForgeOptions;
  #pr: ForgePrState | undefined;
  #title = "";
  #body = "";

  constructor(options: StubForgeOptions = {}) {
    this.#options = options;
  }

  get pullRequest(): ForgePrState | undefined {
    return this.#pr;
  }

  get title(): string {
    return this.#title;
  }

  get body(): string {
    return this.#body;
  }

  /** Clears injected failures so a retry can succeed. */
  clearFailures(): void {
    this.#options.failCreate = undefined;
    this.#options.failReady = undefined;
    this.#options.failMerge = undefined;
  }

  /** Forces the state a forge would report on the next `view`. */
  setState(state: ForgePrState["state"], draft = false): void {
    if (this.#pr === undefined) return;
    this.#pr = { ...this.#pr, state, draft };
  }

  #record(call: StubForgeCall): void {
    this.calls.push(call);
    const { logPath } = this.#options;
    if (logPath === undefined) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify(call)}\n`);
    } catch {
      // The in-memory record is the test's primary evidence.
    }
  }

  async createDraft(input: ForgePrInput): Promise<ForgePrState> {
    this.#record({
      op: "createDraft",
      input: { head: input.head, base: input.base, title: input.title, body: input.body },
    });
    if (this.#options.failCreate !== undefined) throw new Error(this.#options.failCreate);
    const number = this.#options.number ?? 7;
    const base = this.#options.baseUrl ?? "https://forge.test/acme/fixture";
    const url =
      input.target.forge === "github" ? `${base}/pull/${number}` : `${base}/-/merge_requests/${number}`;
    this.#title = input.title;
    this.#body = input.body;
    this.#pr = { number, url, state: "open", draft: true };
    return this.#pr;
  }

  async update(input: ForgePrInput & { number: number }): Promise<void> {
    this.#record({
      op: "update",
      number: input.number,
      input: { title: input.title, body: input.body },
    });
    this.#title = input.title;
    this.#body = input.body;
  }

  async markReady(cwd: string, target: ForgeTarget, number: number): Promise<void> {
    this.#record({ op: "markReady", number, input: { cwd, target } });
    if (this.#options.failReady !== undefined) throw new Error(this.#options.failReady);
    if (this.#pr !== undefined) this.#pr = { ...this.#pr, draft: false };
  }

  async merge(cwd: string, target: ForgeTarget, number: number): Promise<void> {
    this.#record({ op: "merge", number, input: { cwd, target, method: "merge" } });
    if (this.#options.failMerge !== undefined) throw new Error(this.#options.failMerge);
    if (this.#pr !== undefined) this.#pr = { ...this.#pr, state: "merged", draft: false };
  }

  async view(cwd: string, target: ForgeTarget, number: number): Promise<ForgePrState> {
    this.#record({ op: "view", number, input: { cwd, target } });
    if (this.#pr === undefined) throw new Error("No pull request exists.");
    return this.#pr;
  }

  async deleteRemoteBranch(cwd: string, branch: string): Promise<void> {
    this.#record({ op: "deleteRemoteBranch", branch, input: { cwd } });
  }
}
