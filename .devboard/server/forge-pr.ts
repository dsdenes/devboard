import {
  authEnvironment,
  DEFAULT_COMMAND_TIMEOUT_MS,
  isAuthFailure,
  resolveForgeAuth,
  type AuthOutcome,
  type Exec,
  type Forge,
  type ResolveOptions,
  type ResolvedAuth,
} from "../lib/forge-auth.ts";
import {
  DRAFT_PREFIX,
  draftTitle,
  giteaCreatePull,
  giteaEditPull,
  giteaMergePull,
  giteaPull,
  readyTitle,
  type FetchLike,
  type GiteaTarget,
} from "../lib/gitea";

/**
 * The Flow session's pull-request lifecycle against the host's forge.
 *
 * The adapter owns nothing but command shapes: it trades a session branch for a
 * draft PR/MR, turns it live, merges it with a merge commit, and reports its
 * state. Every credential stays in the child environment; no token is ever
 * placed in argv or in an error message. Nothing here creates an issue, an
 * epic, or a tracker query.
 */

export interface ForgeTarget {
  forge: Forge;
  host: string;
  project: string;
  /** Gitea HTTP origin; resolved from configuration or an HTTP origin. */
  baseUrl?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** One PR/MR as the forge reports it. */
export interface ForgePrState {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
}

export interface ForgePrInput {
  cwd: string;
  target: ForgeTarget;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface FlowPrAdapter {
  createDraft(input: ForgePrInput): Promise<ForgePrState>;
  update(input: ForgePrInput & { number: number }): Promise<void>;
  markReady(cwd: string, target: ForgeTarget, number: number): Promise<void>;
  merge(cwd: string, target: ForgeTarget, number: number): Promise<void>;
  view(cwd: string, target: ForgeTarget, number: number): Promise<ForgePrState>;
  deleteRemoteBranch(cwd: string, branch: string): Promise<void>;
}

/** True when a forge command failed; the message keeps the forge's stderr. */
export function forgeFailure(operation: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(
    `Could not ${operation}: ${detail.length === 0 ? `exit code ${result.code}` : detail}`,
  );
}

function numberFromUrl(url: string): number | undefined {
  const match = /\/(?:pulls?|merge_requests)\/(\d+)\/?$/.exec(url.trim());
  const value = match?.[1];
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function firstUrl(text: string): string | undefined {
  const match = /https?:\/\/\S+/.exec(text);
  return match?.[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Normalizes one forge's state spelling to the three states the view knows. */
function normalizedState(value: unknown): ForgePrState["state"] | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "open":
    case "opened":
      return "open";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return undefined;
  }
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  NO_COLOR: "1",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
} as const;

/** Construction seams for tests and the Flow controller's bounded command. */
export interface CommandFlowForgeOptions {
  env?: Record<string, string>;
  /** Injectable credential resolution; production always uses `resolveForgeAuth`. */
  resolve?: (exec: Exec, options: ResolveOptions) => Promise<AuthOutcome>;
  giteaFetch?: FetchLike;
  /** Bound on one forge command and on the whole credential resolution. */
  timeoutMs?: number;
}

/**
 * Runs the host's `gh`/`glab` after resolving a write-capable account for the
 * exact repository. The resolved token lives only in the child environment.
 */
export class CommandFlowForge implements FlowPrAdapter {
  readonly #exec: Exec;
  readonly #env: Record<string, string>;
  readonly #resolver: (exec: Exec, options: ResolveOptions) => Promise<AuthOutcome>;
  readonly #auth = new Map<string, Promise<ResolvedAuth>>();
  readonly #giteaFetch: FetchLike | undefined;
  readonly #timeoutMs: number;

  constructor(exec: Exec, options: CommandFlowForgeOptions = {}) {
    this.#exec = exec;
    this.#env = options.env ?? {};
    this.#resolver = options.resolve ?? resolveForgeAuth;
    this.#giteaFetch = options.giteaFetch;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  }

  async #resolve(target: ForgeTarget, cwd: string): Promise<ResolvedAuth> {
    const key = `${target.forge}:${target.host}:${target.project}`;
    const cached = this.#auth.get(key);
    if (cached !== undefined) return await cached;
    const pending = (async () => {
      const outcome = await this.#resolver(this.#exec, {
        forge: target.forge,
        host: target.host,
        project: target.project,
        cwd,
        required: "write",
        env: { ...process.env, ...this.#env },
        deadline: Date.now() + this.#timeoutMs,
        ...(target.baseUrl === undefined ? {} : { baseUrl: target.baseUrl }),
        ...(this.#giteaFetch === undefined ? {} : { giteaFetch: this.#giteaFetch }),
      });
      if (isAuthFailure(outcome)) throw new Error(outcome.error);
      return outcome;
    })();
    this.#auth.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.#auth.delete(key);
      throw error;
    }
  }

  async #run(
    cwd: string,
    target: ForgeTarget,
    command: string,
    args: string[],
  ): Promise<CommandResult> {
    const auth = await this.#resolve(target, cwd);
    let result: CommandResult;
    try {
      result = await this.#exec(command, args, {
        cwd,
        env: { ...authEnvironment(auth), ...GIT_ENV },
        timeout: this.#timeoutMs,
      });
    } catch (error) {
      result = {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        code: -1,
      };
    }
    return result;
  }

  async #gitea(target: ForgeTarget, cwd: string): Promise<GiteaTarget> {
    const auth = await this.#resolve(target, cwd);
    if (auth.baseUrl === undefined || auth.baseUrl.length === 0) {
      throw new Error("Creating a Gitea pull request needs DEVBOARD_GITEA_URL.");
    }
    return {
      baseUrl: auth.baseUrl,
      project: target.project,
      ...(auth.token === undefined ? {} : { token: auth.token }),
    };
  }

  async createDraft(input: ForgePrInput): Promise<ForgePrState> {
    if (input.target.forge === "gitea") {
      const pull = await giteaCreatePull(
        await this.#gitea(input.target, input.cwd),
        { head: input.head, base: input.base, title: input.title, body: input.body },
        this.#giteaFetch,
      );
      return { number: pull.number, url: pull.url, state: "open", draft: true };
    }
    const args =
      input.target.forge === "github"
        ? [
            "pr",
            "create",
            "--draft",
            "--base",
            input.base,
            "--head",
            input.head,
            "--title",
            input.title,
            "--body",
            input.body,
          ]
        : [
            "mr",
            "create",
            "--draft",
            "--source-branch",
            input.head,
            "--target-branch",
            input.base,
            "--title",
            input.title,
            "--description",
            input.body,
            "--yes",
          ];
    const result = await this.#run(
      input.cwd,
      input.target,
      input.target.forge === "github" ? "gh" : "glab",
      args,
    );
    if (result.code !== 0) throw forgeFailure("create the draft pull request", result);

    const url = firstUrl(result.stdout) ?? firstUrl(result.stderr);
    const number = url === undefined ? undefined : numberFromUrl(url);
    if (url === undefined || number === undefined) {
      throw new Error("Could not create the draft pull request: the forge returned no URL.");
    }
    return { number, url, state: "open", draft: true };
  }

  async update(input: ForgePrInput & { number: number }): Promise<void> {
    if (input.target.forge === "gitea") {
      const gitea = await this.#gitea(input.target, input.cwd);
      // Gitea records draft state in the title. A checkpoint after Ready must
      // not send the WIP: prefix back and silently turn the request into a
      // draft again, so the current state decides the title.
      const current = await giteaPull(gitea, input.number, this.#giteaFetch);
      await giteaEditPull(
        gitea,
        input.number,
        {
          title: current.draft ? draftTitle(input.title) : readyTitle(input.title),
          body: input.body,
        },
        this.#giteaFetch,
      );
      return;
    }
    const args =
      input.target.forge === "github"
        ? ["pr", "edit", String(input.number), "--title", input.title, "--body", input.body]
        : [
            "mr",
            "update",
            String(input.number),
            "--title",
            input.title,
            "--description",
            input.body,
          ];
    const result = await this.#run(
      input.cwd,
      input.target,
      input.target.forge === "github" ? "gh" : "glab",
      args,
    );
    if (result.code !== 0) throw forgeFailure("update the pull request", result);
  }

  async markReady(cwd: string, target: ForgeTarget, number: number): Promise<void> {
    if (target.forge === "gitea") {
      const gitea = await this.#gitea(target, cwd);
      const current = await giteaPull(gitea, number, this.#giteaFetch);
      await giteaEditPull(
        gitea,
        number,
        { title: current.title.startsWith(DRAFT_PREFIX) ? readyTitle(current.title) : current.title },
        this.#giteaFetch,
      );
      return;
    }
    const args =
      target.forge === "github"
        ? ["pr", "ready", String(number)]
        : ["mr", "update", String(number), "--ready"];
    const result = await this.#run(cwd, target, target.forge === "github" ? "gh" : "glab", args);
    if (result.code !== 0) throw forgeFailure("mark the pull request ready", result);
  }

  async merge(cwd: string, target: ForgeTarget, number: number): Promise<void> {
    if (target.forge === "gitea") {
      await giteaMergePull(await this.#gitea(target, cwd), number, this.#giteaFetch);
      return;
    }
    // A merge commit is the only accepted method: never squash, never rebase.
    // glab has no flag that forces a merge commit; it is the default when neither
    // --squash nor --rebase is passed, and `--merge` does not exist there.
    const args =
      target.forge === "github"
        ? ["pr", "merge", String(number), "--merge"]
        : ["mr", "merge", String(number), "--yes"];
    const result = await this.#run(cwd, target, target.forge === "github" ? "gh" : "glab", args);
    if (result.code !== 0) throw forgeFailure("merge the pull request", result);
  }

  async view(cwd: string, target: ForgeTarget, number: number): Promise<ForgePrState> {
    if (target.forge === "gitea") {
      const pull = await giteaPull(await this.#gitea(target, cwd), number, this.#giteaFetch);
      return { number: pull.number, url: pull.url, state: pull.state, draft: pull.draft };
    }
    const args =
      target.forge === "github"
        ? ["pr", "view", String(number), "--json", "number,url,state,isDraft"]
        : ["mr", "view", String(number), "--output", "json"];
    const result = await this.#run(cwd, target, target.forge === "github" ? "gh" : "glab", args);
    if (result.code !== 0) throw forgeFailure("read the pull request", result);

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = asRecord(JSON.parse(result.stdout));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      throw new Error("Could not read the pull request: unexpected forge output.");
    }

    const state = normalizedState(parsed.state);
    const url =
      typeof parsed.url === "string"
        ? parsed.url
        : typeof parsed.web_url === "string"
          ? parsed.web_url
          : undefined;
    if (state === undefined || url === undefined) {
      throw new Error("Could not read the pull request: unexpected forge output.");
    }
    const draft =
      parsed.isDraft === true ||
      parsed.draft === true ||
      (typeof parsed.draft === "boolean" ? parsed.draft : false);
    return { number, url, state, draft };
  }

  async deleteRemoteBranch(cwd: string, branch: string): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.#exec("git", ["push", "origin", "--delete", branch], {
        cwd,
        env: { ...process.env, ...GIT_ENV } as Record<string, string>,
        timeout: this.#timeoutMs,
      });
    } catch (error) {
      result = {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        code: -1,
      };
    }
    if (result.code !== 0) throw forgeFailure(`delete the remote branch ${branch}`, result);
  }
}
