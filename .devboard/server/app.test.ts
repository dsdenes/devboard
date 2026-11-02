import { fixtureRecord, pendingRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp, projectLabel, type InstallerHooks } from "./app";
import {
  detachedRunDirectory,
  detachedRunHandoffPath,
  readDetachedRunState,
} from "./detached-run";
import { journalFile, journalKey } from "./journal";
import {
  remoteProjectDirectory,
  remoteScratchRoot,
  type RemoteCloneRequest,
  type RemoteCloneRunner,
} from "./discover";
import {
  goalDraftControlDirectory,
  goalDraftHandoffPath,
  readGoalDraftOwnerState,
} from "./goal-draft-owner";
import { toolListPayload } from "../mcp/catalog";
import { recordToolInvocation } from "../mcp/invocations";
import { ProviderService, saveSubscriptions } from "./providers";
import { acquireLock, pidAlive } from "../issues/lock";
import { testProviderService } from "./fixtures/test-providers";
import type { TrackerRead } from "./issue-sync";
import type { OpenEpic } from "./tracker";

const temporaryDirectories: string[] = [];
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-app-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const GUARD_TEST_ROOT = join(import.meta.dir, "..", ".tmp", "flow-guard-app-tests");
mkdirSync(GUARD_TEST_ROOT, { recursive: true });

/** One fixture directory under the harness, never the system temporary root. */
function guardDirectory(name: string): string {
  const directory = join(
    GUARD_TEST_ROOT,
    `${name}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  );
  mkdirSync(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

/** Makes a fixture a harness source checkout so Discover's remote target exists. */
function sourceCheckout(root: string): void {
  mkdirSync(join(root, ".devboard"), { recursive: true });
  writeFileSync(
    join(root, ".devboard", "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.0.0" }, null, 2)}\n`,
  );
}

/** A directory an injected clone copies; no test reaches the network. */
function cloneSource(name: string, breakStaging = false): string {
  const root = guardDirectory(name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n\nA remote fixture.\n`);
  writeFileSync(join(root, "src", "main.txt"), "remote\n");
  // A file where the run needs `.omp/discover/staging` makes the staging
  // preparation throw after the clone succeeded.
  if (breakStaging) writeFileSync(join(root, ".omp"), "not a directory\n");
  return root;
}

/** Records every clone and copies `source` into the destination it names. */
function cloneRecorder(source: string): {
  calls: RemoteCloneRequest[];
  runner: RemoteCloneRunner;
} {
  const calls: RemoteCloneRequest[] = [];
  const runner: RemoteCloneRunner = async (request) => {
    calls.push(request);
    const destination = join(request.cwd, request.argv[request.argv.length - 1] ?? "");
    cpSync(source, destination, { recursive: true, force: true });
    return { code: 0, stderr: "", timedOut: false };
  };
  return { calls, runner };
}

/** Writes one retained remote project the snapshot lists and switches to. */
function seedRetainedProject(root: string, owner: string, repo: string, marker: string): string {
  const stateDir = join(root, "state");
  const directory = remoteProjectDirectory(remoteScratchRoot(stateDir), owner, repo);
  mkdirSync(join(directory, ".omp", "discover"), { recursive: true });
  mkdirSync(join(directory, ".omp", "skills"), { recursive: true });
  writeFileSync(join(directory, ".omp", "discover", "marker.txt"), marker);
  writeFileSync(join(directory, ".omp", "skills", "marker.txt"), marker);
  writeFileSync(
    join(directory, "project.json"),
    `${JSON.stringify(
      {
        url: `https://github.com/${owner}/${repo}`,
        owner,
        repo,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

/** True when a Discover snapshot reports a remote checkout. */
function snapshotCheckout(frame: Record<string, unknown>): boolean {
  const state = frame.state;
  if (state === null || typeof state !== "object" || !("target" in state)) return false;
  const target = state.target;
  if (target === null || typeof target !== "object" || !("checkout" in target)) return false;
  return target.checkout === true;
}

/** The repository a Discover snapshot names, or undefined for the host. */
function snapshotRepository(frame: Record<string, unknown>): string | undefined {
  const state = frame.state;
  if (state === null || typeof state !== "object" || !("repository" in state)) return undefined;
  const repository = state.repository;
  return typeof repository === "string" ? repository : undefined;
}

/** The kind of target a Discover snapshot names: `remote` or `host`. */
function snapshotTargetKind(frame: Record<string, unknown>): string | undefined {
  const state = frame.state;
  if (state === null || typeof state !== "object" || !("target" in state)) return undefined;
  const target = state.target;
  if (target === null || typeof target !== "object" || !("kind" in target)) return undefined;
  return typeof target.kind === "string" ? target.kind : undefined;
}

/** Every transient `.staging-*` entry under the harness remote scratch root. */
function stagingEntries(root: string): string[] {
  const scratch = remoteScratchRoot(join(root, "state"));
  try {
    return readdirSync(scratch).filter((entry) => entry.startsWith(".staging-"));
  } catch {
    return [];
  }
}

async function startServer(
  options: {
    goalText?: string;
    goalFile?: string;
    agentCommand?: string;
    restart?: () => void;
    versionState?: () => {
      running: string | null;
      installed: string | null;
      latest: string | null;
      stale: boolean;
    };
    runningVersion?: string | null;
    /** Installs this checkout's `origin` before the app resolves it. */
    origin?: string;
    hostname?: string;
    allowedHosts?: string[];
    providers?: (stateDir: string) => ProviderService;
    providersRefreshMs?: number;
    /** Reuses an existing fixture root for an in-process replacement. */
    root?: string;
    /** Replaces the default accepted ADR with the given markdown. */
    adrSource?: string;
    /** Tracker responses for lifecycle lanes. */
    tracker?: (repoDir: string) => Promise<OpenEpic | undefined>;
    /** Seeds one managed prepare-family skill. */
    prepareSkill?: boolean;
    /** Injects the Discover clone so no test reaches the network. */
    discoverClone?: RemoteCloneRunner;
    issues?: {
      closeIssue?: (request: {
        repoDir: string;
        repository: string;
        number: number;
      }) => Promise<void>;
      syncRead?: TrackerRead;
    };
  } = {},
) {
  const root = options.root ?? (await temporaryDirectory());
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  await writeFile(
    join(adrDir, "0001-first.md"),
    options.adrSource ?? fixtureRecord("0001-first.md", "First"),
  );
  if (options.prepareSkill === true) {
    await mkdir(join(root, ".omp", "skills", "behavior-first-testing"), { recursive: true });
    await writeFile(
      join(root, ".omp", "skills", "behavior-first-testing", "SKILL.md"),
      [
        "---",
        "name: behavior-first-testing",
        "description: Choose tests by observable behavior.",
        "metadata:",
        '  devboard-managed: "true"',
        "---",
        "",
        "# Behavior-first testing",
        "",
        "- Prefer observable behavior over implementation details.",
        "",
      ].join("\n"),
    );
  }
  if (options.origin !== undefined) {
    Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
    Bun.spawnSync({ cmd: ["git", "-C", root, "remote", "add", "origin", options.origin] });
  }
  if (options.goalText !== undefined) {
    await writeFile(options.goalFile ?? join(root, "GOAL.md"), options.goalText);
  }

  const syncRead: TrackerRead =
    options.issues?.syncRead ?? (async () => ({ kind: "not-modified", etag: null }));

  const server = createApp({
    adrDir,
    staticDir,
    hostname: options.hostname ?? "127.0.0.1",
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers: options.providers?.(join(root, "state")) ?? testProviderService(join(root, "state")),
    providersRefreshMs: options.providersRefreshMs,
    goalFile: options.goalFile,
    agentCommand: options.agentCommand,
    restart: options.restart,
    tracker: options.tracker,
    versionState: options.versionState,
    runningVersion: options.runningVersion,
    ...(options.discoverClone === undefined ? {} : { discoverClone: options.discoverClone }),
    ...(options.issues === undefined
      ? { issues: { syncRead } }
      : { issues: { ...options.issues, syncRead } }),
  });
  return { server, adrDir, root, url: `127.0.0.1:${server.port}` };
}

function exchange(url: string, command: unknown): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const socket = new WebSocket(`ws://${url}/ws`);

  socket.onopen = () => socket.send(JSON.stringify(command));
  const answer = (command as { type?: unknown }).type === "getIssues";
  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      socket.close();
      reject(error);
      return;
    }
    const type = (message as { type?: unknown }).type;
    // Discover's card prompts and snapshot are connection-level replays that
    // precede every client's own reply.
    if (type === "discoverPromptState" || type === "discoverState") return;
    // A connection-level worker replay precedes this client's own reply.
    if (
      !answer &&
      (type === "issuesState" ||
        type === "issuesActivity" ||
        type === "agentsState" ||
        type === "agentState" ||
        type === "agentActivity" ||
        type === "agentPromptState")
    ) {
      return;
    }
    socket.close();
    resolve(message);
  };
  socket.onerror = () => reject(new Error("websocket failed"));

  return promise;
}

/**
 * Collects socket frames until `done` accepts them. The guard timer only keeps
 * a broken contract from hanging the suite; the assertion is the predicate.
 */
function collect(
  url: string,
  command: unknown,
  done: (messages: unknown[]) => boolean,
): Promise<unknown[]> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const messages: unknown[] = [];
  const guard = setTimeout(() => {
    socket.close();
    reject(new Error("websocket frames did not arrive"));
  }, 5000);
  socket.onopen = () => socket.send(JSON.stringify(command));
  socket.onmessage = (event) => {
    try {
      messages.push(JSON.parse(String(event.data)));
    } catch (error) {
      clearTimeout(guard);
      socket.close();
      reject(error);
      return;
    }
    if (!done(messages)) return;
    clearTimeout(guard);
    socket.close();
    resolve(messages);
  };
  socket.onerror = () => {
    clearTimeout(guard);
    reject(new Error("websocket failed"));
  };
  return promise;
}

/** A connected tab that keeps every frame it received. */
interface WatchedFrames {
  send(command: unknown): void;
  waitFor(
    predicate: (frame: Record<string, unknown>) => boolean,
    label: string,
    timeoutMs?: number,
    from?: number,
  ): Promise<Record<string, unknown>>;
  mark(): number;
  frames(): Record<string, unknown>[];
  close(): void;
}

/**
 * Keeps every frame a socket receives so a test can observe what a second
 * connected tab holds. Resolves once the socket is open and able to send.
 */
async function watchFrames(url: string): Promise<WatchedFrames> {
  const socket = new WebSocket(`ws://${url}/ws`);
  const frames: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (frame: Record<string, unknown>) => boolean;
    settle: (frame: Record<string, unknown>) => void;
  }[] = [];
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate(frame)) continue;
      waiters.splice(index, 1);
      waiter.settle(frame);
    }
  };
  const opened = Promise.withResolvers<void>();
  socket.onopen = () => opened.resolve();
  socket.onerror = () => opened.reject(new Error("websocket failed"));
  await opened.promise;
  return {
    send(command) {
      socket.send(JSON.stringify(command));
    },
    waitFor(predicate, label, timeoutMs = 15_000, from = 0) {
      const received = frames.slice(from).find(predicate);
      if (received !== undefined) return Promise.resolve(received);
      const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
      const waiter = { predicate, settle: resolve };
      waiters.push(waiter);
      // Only a guard against a broken contract hanging the suite; the awaited
      // frame is the signal, never this duration.
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index < 0) return;
        waiters.splice(index, 1);
        reject(
          new Error(
            `timed out waiting for ${label}; saw ${JSON.stringify(
              frames.map((frame) =>
                frame.type === "error" ? { type: frame.type, message: frame.message } : frame.type,
              ),
            )}`,
          ),
        );
      }, timeoutMs);
      return promise;
    },
    mark() {
      return frames.length;
    },
    frames() {
      return [...frames];
    },
    close() {
      socket.close();
    },
  };
}

function listRecords(url: string): Promise<unknown> {
  return exchange(url, { type: "listRecords" });
}

describe("projectLabel", () => {
  test("names a project inside the home directory by its relative path", () => {
    const home = join(homedir(), "projects");

    expect(projectLabel(join(home, "devboard"), home)).toBe("devboard");
    expect(projectLabel(join(home, "nested", "dashboard"), home)).toBe(
      join("nested", "dashboard"),
    );
  });

  test("keeps the absolute path for a project outside the home directory", () => {
    const home = join(homedir(), "projects");
    const outside = resolve(home, "..", "elsewhere");

    expect(projectLabel(outside, home)).toBe(outside);
  });

  test("keeps the absolute path for the home directory itself", () => {
    const home = join(homedir(), "projects");

    expect(projectLabel(home, home)).toBe(home);
  });
});

describe("createApp", () => {
  test("serves the built client at the root", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("<title>ADR overview</title>");
    } finally {
      server.stop(true);
    }
  });

  test("answers listRecords over the WebSocket", async () => {
    const { server, url } = await startServer();

    try {
      const message = await listRecords(url);

      expect(message).toEqual({
        type: "records",
        records: [
          {
            file: "0001-first.md",
            title: "First",
            status: "Accepted",
            pending: false,
            summary: "",
          },
        ],
        next: null,
      });
    } finally {
      server.stop(true);
    }
  });

  test("refuses a cross-origin WebSocket upgrade and accepts a same-origin one", async () => {
    const { server, url } = await startServer();

    try {
      const refused = await fetch(`http://${url}/ws`, {
        headers: {
          Origin: "https://evil.example",
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe("Cross-origin WebSocket upgrades are refused.");

      // The ambient WebSocket type is the DOM one, which has no Bun options.
      const Socket = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const socket = new Socket(`ws://${url}/ws`, {
        headers: { Origin: `http://${url}` },
      });
      socket.onopen = () => {
        socket.close();
        resolve(true);
      };
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
      expect(await promise).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a WebSocket upgrade whose Host is not one of the listener's names", async () => {
    const { server, url } = await startServer();

    try {
      // Host and Origin agree with each other and the Host was rewritten by the
      // page, so only the listener's own allowlist can refuse this upgrade.
      const host = `evil.example:${server.port}`;
      const refused = await fetch(`http://${url}/ws`, {
        headers: {
          Host: host,
          Origin: `http://${host}`,
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe("The request host is not served by this dashboard.");
    } finally {
      server.stop(true);
    }
  });

  test("a wildcard bind serves loopback and its allowlist, never another Host", async () => {
    const { server, url } = await startServer({
      hostname: "0.0.0.0",
      allowedHosts: ["dashboard.example"],
    });

    try {
      const evil = `evil.example:${server.port}`;
      const refused = await fetch(`http://${url}/ws`, {
        headers: {
          Host: evil,
          Origin: `http://${evil}`,
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      expect(refused.status).toBe(403);

      const Socket = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const { promise, resolve } = Promise.withResolvers<boolean>();
      const allowed = `dashboard.example:${server.port}`;
      const socket = new Socket(`ws://${url}/ws`, {
        headers: { Host: allowed, Origin: `http://${allowed}` },
      });
      socket.onopen = () => {
        socket.close();
        resolve(true);
      };
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
      expect(await promise).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("restarts once on request and refuses a concurrent restart", async () => {
    let restarts = 0;
    const { server, url } = await startServer({ restart: () => (restarts += 1) });

    try {
      expect(await exchange(url, { type: "restartServer" })).toEqual({
        type: "serverRestarting",
      });
      expect(restarts).toBe(1);
      expect(await exchange(url, { type: "restartServer" })).toEqual({
        type: "error",
        message: "A server restart is already in progress.",
      });
      expect(restarts).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("keeps serving after a failed restart", async () => {
    const { server, url } = await startServer({
      restart: () => {
        throw new Error("spawn failed");
      },
    });

    try {
      const messages = await collect(
        url,
        { type: "restartServer" },
        (frames) =>
          frames.some(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "type" in frame &&
              frame.type === "error",
          ),
      );
      expect(messages.at(-1)).toEqual({
        type: "error",
        message: "Could not restart the server: spawn failed",
      });
      expect(await listRecords(url)).toMatchObject({ type: "records" });
    } finally {
      server.stop(true);
    }
  });

  test("reports that restarting is unavailable without a launcher", async () => {
    const { server, url } = await startServer();

    try {
      expect(await exchange(url, { type: "restartServer" })).toEqual({
        type: "error",
        message: "Restarting the server is not available.",
      });
    } finally {
      server.stop(true);
    }
  });

  test("answers getVersion from the supplied probe", async () => {
    const { server, url } = await startServer({
      versionState: () => ({ running: "old", installed: "new", latest: "new", stale: true }),
    });

    try {
      expect(await exchange(url, { type: "getVersion" })).toEqual({
        type: "versionState",
        running: "old",
        installed: "new",
        latest: "new",
        stale: true,
        feedbackEnabled: false,
      });
    } finally {
      server.stop(true);
    }
  });

  test("answers getMcpTools with the tools/list payload and per-tool invocation counts", async () => {
    const { server, root, url } = await startServer();

    try {
      const stateDir = join(root, "state");
      recordToolInvocation(stateDir, root, "journal_search");
      recordToolInvocation(stateDir, root, "journal_search");
      recordToolInvocation(stateDir, root, "devboard_status");

      expect(await exchange(url, { type: "getMcpTools" })).toEqual({
        type: "mcpTools",
        tools: toolListPayload().tools,
        invocations: { devboard_status: 1, journal_search: 2 },
      });
    } finally {
      server.stop(true);
    }
  });

  test("answers getProject with the project directory label", async () => {
    const { server, root, url } = await startServer();

    try {
      expect(await exchange(url, { type: "getProject" })).toEqual({
        type: "project",
        path: projectLabel(root),
      });
    } finally {
      server.stop(true);
    }
  });

  test("re-reads the record directory for every command", async () => {
    const { server, adrDir, url } = await startServer();

    try {
      expect(await listRecords(url)).toMatchObject({ next: null });

      await writeFile(join(adrDir, "0002-added.md"), fixtureRecord("0002-added.md", "Added", "proposed"));
      expect(await listRecords(url)).toMatchObject({ next: "0002-added.md" });

      await rm(join(adrDir, "0002-added.md"));
      expect(await listRecords(url)).toMatchObject({ next: null });
    } finally {
      server.stop(true);
    }
  });

  test("answers getGoal with the complete goal file contents", async () => {
    const goalText = "Original goal\nsecond line\n";
    const { server, url } = await startServer({ goalText });

    try {
      expect(await exchange(url, { type: "getGoal" })).toEqual({ type: "goal", text: goalText });
    } finally {
      server.stop(true);
    }
  });

  test("answers the agent prompt surface read-only on an installed prefix", async () => {
    const { root, url } = await startServer();
    await mkdir(join(root, ".devboard", "prompts"), { recursive: true });
    await writeFile(
      join(root, ".devboard", "prompts", "scout-recommendations.md"),
      "# Installed prompt\n",
    );

    const frames = await collect(
      url,
      { type: "getAgentPrompt", id: "scout" },
      (messages) =>
        messages.some(
          (message) =>
            (message as { type?: string; id?: string }).type === "agentPromptState" &&
            (message as { id?: string }).id === "scout",
        ),
    );
    const scout = frames.find(
      (message) => (message as { type?: string }).type === "agentPromptState",
    ) as { prompt: Record<string, unknown> };
    expect(scout.prompt).toEqual({
      id: "scout",
      absent: false,
      text: "# Installed prompt\n",
      error: null,
    });

    const watchdogFrames = await collect(
      url,
      { type: "getAgentPrompt", id: "watchdog" },
      (messages) =>
        messages.some(
          (message) =>
            (message as { type?: string; id?: string }).type === "agentPromptState" &&
            (message as { id?: string }).id === "watchdog",
        ),
    );
    const watchdog = watchdogFrames.find(
      (message) =>
        (message as { type?: string; id?: string }).type === "agentPromptState" &&
        (message as { id?: string }).id === "watchdog",
    ) as { prompt: Record<string, unknown> };
    expect(watchdog.prompt).toEqual({
      id: "watchdog",
      absent: true,
      text: null,
      error: null,
    });

    expect(
      await exchange(url, { type: "saveAgentPrompt", id: "scout", text: "changed\n" }),
    ).toEqual({ type: "error", message: "Invalid WebSocket message." });
    expect(
      readFileSync(join(root, ".devboard", "prompts", "scout-recommendations.md"), "utf8"),
    ).toBe("# Installed prompt\n");
  });

  test("refuses every removed hand-write command without touching its file", async () => {
    const goalFile = join(await temporaryDirectory(), "GOAL.md");
    const { root, url } = await startServer({ goalFile, goalText: "Original\n" });
    const goalBytes = await readFile(goalFile, "utf8");
    const removed = [
      { type: "saveGoal", text: "changed\n" },
      { type: "saveFlowGoal", text: "changed\n" },
      { type: "saveFlowDecisions", text: "changed\n" },
      { type: "saveDiscoverPrompt", agent: "sheet", text: "changed\n" },
      { type: "chatDiscoverPrompt", agent: "sheet", message: "change it", text: "base" },
      { type: "saveDiscoverSkill", name: "discover-testing-strategy", text: "changed\n" },
      { type: "restoreDiscoverSkill", name: "discover-testing-strategy" },
    ] as const;
    for (const command of removed) {
      expect(await exchange(url, command)).toEqual({
        type: "error",
        message: "Invalid WebSocket message.",
      });
    }
    expect(await readFile(goalFile, "utf8")).toBe(goalBytes);
    expect(existsSync(join(root, ".omp", "skills"))).toBe(false);
  });

  test("does not start an agent while loading the goal", async () => {
    const logPath = join(await temporaryDirectory(), "agent.log");
    const { server, url } = await startServer({
      goalText: "Goal\n",
      agentCommand: `bun ${STUB_AGENT} --log=${logPath}`,
    });

    try {
      await exchange(url, { type: "getGoal" });

      expect(existsSync(logPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("refreshes provider usage on the interval only while a client is connected", async () => {
    // This exercises the server's real interval against the platform clock;
    // fake timers cannot drive the WebSocket delivery it proves.
    let calls = 0;
    const secondFetch = Promise.withResolvers<void>();
    const fetchUsage = (async () => {
      calls += 1;
      if (calls === 2) secondFetch.resolve();
      const body = {
        usage: {
          rolling: { percent: 10 },
          weekly: { percent: 20 },
          monthly: { percent: 30 },
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { server, url } = await startServer({
      providersRefreshMs: 20,
      providers: (stateDir) => {
        saveSubscriptions(stateDir, [
          {
            id: "go",
            provider: "opencode-go",
            label: "Go",
            key: "sk-test-key",
            enabled: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]);
        return new ProviderService({ stateDir, fetch: fetchUsage });
      },
    });

    try {
      await Bun.sleep(80);
      expect(calls).toBe(0);

      const twoFrames = Promise.withResolvers<void>();
      const frames: Record<string, unknown>[] = [];
      const socket = new WebSocket(`ws://${url}/ws`);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (message.type !== "providersState") return;
        frames.push(message);
        if (frames.length === 2) twoFrames.resolve();
      };
      const opened = Promise.withResolvers<void>();
      socket.onopen = () => opened.resolve();
      await opened.promise;
      socket.send(JSON.stringify({ type: "getProviders" }));

      await Promise.race([secondFetch.promise, Bun.sleep(2_000)]);
      await Promise.race([twoFrames.promise, Bun.sleep(2_000)]);
      socket.close();

      expect(calls).toBeGreaterThanOrEqual(2);
      expect(frames.length).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  });

  test("a provider change is answered under the request id that sent it", async () => {
    const { server, url } = await startServer();

    try {
      const socket = new WebSocket(`ws://${url}/ws`);
      const opened = Promise.withResolvers<void>();
      const ackSeen = Promise.withResolvers<void>();
      const refusalSeen = Promise.withResolvers<void>();
      const frames: Record<string, unknown>[] = [];
      socket.onopen = () => opened.resolve();
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as Record<string, unknown>;
        frames.push(message);
        if (message.type === "providerChanged") ackSeen.resolve();
        if (message.type === "providerError") refusalSeen.resolve();
      };
      await opened.promise;

      socket.send(
        JSON.stringify({
          type: "saveProvider",
          requestId: 41,
          provider: "opencode-go",
          label: "Second",
          key: "sk-second-test-key",
        }),
      );
      // A change with no id is refused instead of applied unacknowledged: no
      // client could tell its answer from someone else's state frame.
      socket.send(JSON.stringify({ type: "deleteProvider", id: "test-opencode-go" }));
      await Promise.race([ackSeen.promise, Bun.sleep(2_000)]);
      await Promise.race([refusalSeen.promise, Bun.sleep(2_000)]);
      socket.close();

      const ack = frames.find((frame) => frame.type === "providerChanged");
      expect(ack).toEqual({ type: "providerChanged", requestId: 41 });
      const ackIndex = frames.indexOf(ack as Record<string, unknown>);
      expect(ackIndex).toBeGreaterThanOrEqual(0);
      // The masked state follows the acknowledgement that names the request.
      expect(frames.slice(ackIndex).some((frame) => frame.type === "providersState")).toBe(true);
      const refusal = frames.find((frame) => frame.type === "providerError");
      expect(String(refusal?.message)).toContain("request id");
      // The id-less delete neither applied nor answered as a change.
      expect(frames.filter((frame) => frame.type === "providerChanged")).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});

/** One issues state document as the worker writes it, scoped to `repoDir`. */
function issuesDocument(repoDir: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    repo: "acme/fixture",
    root: resolve(repoDir),
    lifecycle: "running",
    enabled: true,
    paused: false,
    worker: {
      pid: process.pid,
      startedAt: "2026-10-27T10:00:00.000Z",
      stateDir: "",
      harnessVersion: "0.1.0",
      argv: ["bun", "issues/worker.ts"],
    },
    poll: {
      intervalMs: 2000,
      lastPollAt: "2026-10-27T10:00:00.000Z",
      nextPollAt: "2026-10-27T10:00:02.000Z",
      etag: '"etag"',
      notModified: false,
      rateLimitedUntil: null,
      error: null,
    },
    queue: [
      {
        number: 7,
        title: "First issue",
        url: "https://github.com/acme/fixture/issues/7",
        createdAt: "2026-10-26T00:00:00Z",
        handled: false,
        runId: null,
        agentRunId: "2026-10-27T10-00-01-000Z",
      },
      {
        number: 8,
        title: "Second issue",
        url: "https://github.com/acme/fixture/issues/8",
        createdAt: "2026-10-26T01:00:00Z",
        handled: true,
        runId: "2026-10-27T09-00-00-000Z",
        agentRunId: null,
      },
      {
        number: 9,
        title: "Third issue",
        url: "https://github.com/acme/fixture/issues/9",
        createdAt: "2026-10-26T02:00:00Z",
        handled: false,
        runId: null,
        agentRunId: "2026-10-27T10-00-02-000Z",
      },
    ],
    runs: [
      {
        runId: "2026-10-27T09-00-00-000Z",
        status: "succeeded",
        startedAt: "2026-10-27T09:00:00.000Z",
        finishedAt: "2026-10-27T09:01:00.000Z",
        exitCode: 0,
        issueNumbers: [8],
        activity: 1,
        firstStderrLine: null,
      },
      {
        runId: "2026-10-27T10-00-01-000Z",
        status: "running",
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: null,
        exitCode: null,
        issueNumbers: [7],
        activity: 2,
        firstStderrLine: null,
      },
      {
        runId: "2026-10-27T10-00-02-000Z",
        status: "running",
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: null,
        exitCode: null,
        issueNumbers: [9],
        activity: 1,
        firstStderrLine: null,
      },
    ],
    agents: [
      {
        runId: "2026-10-27T10-00-01-000Z",
        issueNumber: 7,
        startedAt: "2026-10-27T10:00:00.000Z",
        question: null,
        acp: { pid: process.pid, argv: ["omp", "acp"], cwd: resolve(repoDir) },
      },
      {
        runId: "2026-10-27T10-00-02-000Z",
        issueNumber: 9,
        startedAt: "2026-10-27T10:00:00.000Z",
        question: {
          id: 5,
          message: "Which scope?",
          options: [],
        },
        acp: null,
      },
    ],
    cooldowns: { "10": "2026-10-27T10:05:00.000Z" },
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: "2026-10-27T10:00:01.000Z",
    ...overrides,
  };
}

/** Seeds the repo-scoped state and the repo-anchored lock, as a worker would. */
async function seedIssues(root: string, overrides: Record<string, unknown> = {}) {
  const stateDir = join(root, "state");
  const directory = join(stateDir, "issues", journalKey(resolve(root)));
  await mkdir(directory, { recursive: true });
  const document = issuesDocument(root, overrides);
  const worker = document.worker as Record<string, unknown>;
  worker.stateDir = stateDir;
  await writeFile(join(directory, "state.json"), JSON.stringify(document));
  const lock = acquireLock(join(root, ".devboard", ".tmp", "issues", "lock"), {
    repo: resolve(root),
    stateDir,
    harnessVersion: "0.1.0",
    argv: ["bun", "issues/worker.ts"],
  });
  expect(lock.acquired).toBe(true);
  return { stateDir, directory, document, lock };
}

function serverErrors(stateDir: string, root: string): string[] {
  const path = journalFile(stateDir, resolve(root));
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { kind?: string; text?: string })
    .filter((record) => record.kind === "server-error")
    .map((record) => record.text ?? "");
}

describe("issues protocol", () => {
  test("opens stopped, not an error, when no worker state exists", async () => {
    const { server, root, url } = await startServer();

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.type).toBe("issuesState");
      expect(message.present).toBe(false);
      expect(message.lifecycle).toBe("stopped");
      expect(message.enabled).toBe(false);
      expect(message.attached).toBe(false);
      expect(message.repo).toBeNull();
      expect(serverErrors(join(root, "state"), root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("replays the checkout origin on connect before any worker exists", async () => {
    const { server, url } = await startServer({
      origin: "https://github.com/acme/fixture.git",
    });

    try {
      const frames = await collect(url, { type: "getProject" }, (messages) =>
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "agentsState",
        ),
      );
      const issues = frames.find(
        (frame): frame is { repo?: unknown; present?: unknown } =>
          typeof frame === "object" &&
          frame !== null &&
          "type" in frame &&
          frame.type === "issuesState",
      );
      const agentsFrame = frames.find(
        (frame): frame is { agents?: Array<{ id?: string }> } =>
          typeof frame === "object" &&
          frame !== null &&
          "type" in frame &&
          frame.type === "agentsState",
      );
      expect(issues?.repo).toBe("acme/fixture");
      expect(issues?.present).toBe(false);
      expect(agentsFrame?.agents?.map((agent) => agent.id)).toEqual([
        "scout",
        "watchdog",
        "design",
        "coach",
        "release-train",
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("opens stopped for damaged bytes without a journal error", async () => {
    const { server, root, url } = await startServer();
    const stateDir = join(root, "state");
    const directory = join(stateDir, "issues", journalKey(resolve(root)));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "state.json"), '{"version": 1, "root":');

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.present).toBe(false);
      expect(message.lifecycle).toBe("stopped");
      expect(serverErrors(stateDir, root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("replays a seeded worker snapshot with every running agent", async () => {
    const { server, root, url } = await startServer();
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.type).toBe("issuesState");
      expect(message.present).toBe(true);
      expect(message.attached).toBe(true);
      expect(message.lifecycle).toBe("running");
      expect(message.repo).toBe("acme/fixture");
      expect((message.queue as Array<{ number: number }>).map((entry) => entry.number)).toEqual([
        7, 8, 9,
      ]);
      const agents = message.agents as Array<{ runId: string; issueNumber: number }>;
      expect(agents.map((agent) => agent.issueNumber)).toEqual([7, 9]);
      expect(message.cooldowns).toEqual({ "10": "2026-10-27T10:05:00.000Z" });
      expect(message.activeRun).toBeUndefined();
      expect(message.question).toBeUndefined();
      expect(message.nextAttemptAt).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("replays every running agent's activity on connect", async () => {
    const { server, root, url } = await startServer();
    const { directory } = await seedIssues(root);
    for (const [runId, lines] of [
      ["2026-10-27T10-00-01-000Z", ["agent one", "working one"]],
      ["2026-10-27T10-00-02-000Z", ["agent two"]],
    ] as const) {
      await mkdir(join(directory, "runs", runId), { recursive: true });
      await writeFile(join(directory, "runs", runId, "activity.json"), JSON.stringify(lines));
    }

    try {
      const messages = await collect(url, { type: "getIssues" }, (received) => {
        const replays = received.filter(
          (message) =>
            (message as { type?: string }).type === "issuesActivity" &&
            (message as { replay?: boolean }).replay === true,
        );
        return replays.length >= 2;
      });
      const replays = messages.filter(
        (message) =>
          (message as { type?: string }).type === "issuesActivity" &&
          (message as { replay?: boolean }).replay === true,
      );
      expect(replays).toHaveLength(2);
      const byRun = new Map(
        replays.map((message) => {
          const entry = message as { runId: string; entries: Array<{ text: string }> };
          return [entry.runId, entry.entries.map((item) => item.text)] as const;
        }),
      );
      expect(byRun.get("2026-10-27T10-00-01-000Z")).toEqual(["agent one", "working one"]);
      expect(byRun.get("2026-10-27T10-00-02-000Z")).toEqual(["agent two"]);
    } finally {
      server.stop(true);
    }
  });

  test("answerIssues refuses a missing or unknown run id and routes a valid one", async () => {
    const { server, root, url } = await startServer();
    await seedIssues(root);
    const control = join(root, "state", "issues", journalKey(resolve(root)), "control");

    try {
      const missing = (await exchange(url, {
        type: "answerIssues",
        id: 5,
        value: "answer",
      })) as Record<string, unknown>;
      expect(missing.type).toBe("error");
      expect(String(missing.message)).toContain("run id");

      const unknown = (await exchange(url, {
        type: "answerIssues",
        id: 5,
        value: "answer",
        runId: "2026-10-27T11-00-00-000Z",
      })) as Record<string, unknown>;
      expect(unknown.type).toBe("error");
      expect(String(unknown.message)).toContain("2026-10-27T11-00-00-000Z");

      // A routed answer has no acknowledgement; it reaches the command dir.
      const socket = new WebSocket(`ws://${url}/ws`);
      await new Promise<void>((resolve) => {
        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "answerIssues",
              id: 5,
              value: "the whole goal",
              runId: "2026-10-27T10-00-02-000Z",
            }),
          );
          resolve();
        };
      });

      // The command reaches the control directory; the worker consumes it.
      let command: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100 && command === undefined; attempt += 1) {
        if (existsSync(control)) {
          const name = readdirSync(control).find((entry) => entry.endsWith(".json"));
          if (name !== undefined) {
            command = JSON.parse(readFileSync(join(control, name), "utf8")) as Record<
              string,
              unknown
            >;
            break;
          }
        }
        await Bun.sleep(10);
      }
      socket.close();
      expect(command).toEqual({
        type: "answer",
        id: 5,
        value: "the whole goal",
        runId: "2026-10-27T10-00-02-000Z",
      });
    } finally {
      server.stop(true);
    }
  });

  test("serves a run detail from the repo-scoped history", async () => {
    const { server, root, url } = await startServer();
    const { directory } = await seedIssues(root);
    const runId = "2026-10-27T09-00-00-000Z";
    const runDirectory = join(directory, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        version: 1,
        runId,
        repo: "acme/fixture",
        status: "succeeded",
        argv: ["omp", "acp"],
        cwd: resolve(root),
        startedAt: "2026-10-27T09:00:00.000Z",
        finishedAt: "2026-10-27T09:01:00.000Z",
        exitCode: 0,
        issues: [
          {
            number: 8,
            title: "Second issue",
            url: "https://github.com/acme/fixture/issues/8",
            createdAt: "2026-10-26T01:00:00Z",
          },
        ],
        firstStderrLine: null,
        workerPid: process.pid,
        harnessVersion: "0.1.0",
      }),
    );
    await writeFile(join(runDirectory, "activity.json"), JSON.stringify(["handled #8"]));

    try {
      const message = (await exchange(url, { type: "getIssuesRun", runId })) as Record<string, unknown>;
      expect(message.type).toBe("issuesRun");
      expect((message.run as { runId: string }).runId).toBe(runId);
      expect((message.run as { activityLines: string[] }).activityLines).toEqual(["handled #8"]);
      const missing = (await exchange(url, { type: "getIssuesRun", runId: "../../etc/passwd" })) as Record<string, unknown>;
      expect(missing.type).toBe("error");
    } finally {
      server.stop(true);
    }
  });

  test("opens stopped when the state is present but no live lock remains", async () => {
    const { server, root, url } = await startServer();
    await seedIssues(root);
    await rm(join(root, ".devboard", ".tmp", "issues", "lock"), { force: true });

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.present).toBe(true);
      expect(message.attached).toBe(false);
      expect(message.lifecycle).toBe("stopped");
      expect(message.enabled).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("refuses Start when this checkout's worker uses another state directory", async () => {
    const { server, root, url } = await startServer();
    const { stateDir, lock: seeded } = await seedIssues(root);
    // Replace the seeded lock with an equally live one naming another state.
    if (seeded.acquired) seeded.release();
    const held = acquireLock(join(root, ".devboard", ".tmp", "issues", "lock"), {
      repo: resolve(root),
      stateDir: join(root, "other-state"),
      harnessVersion: "0.1.0",
      argv: ["bun", "issues/worker.ts"],
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    try {
      const message = (await exchange(url, { type: "startIssues" })) as Record<string, unknown>;
      expect(message.type).toBe("error");
      expect(String(message.message)).toContain(String(join(root, "other-state")));
      expect(String(message.message)).toContain(String(stateDir));
    } finally {
      server.stop(true);
    }
  });

  test("reports no version divergence for a worker of another version", async () => {
    const { server, root, url } = await startServer({ runningVersion: "0.2.0" });
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.notice).toBeNull();
      expect(message.workers).toEqual([
        {
          pid: expect.any(Number),
          version: "0.1.0",
          stateDir: expect.any(String),
          lifecycle: expect.any(String),
        },
      ]);
      expect(JSON.stringify(message)).not.toContain("dashboard" + " loaded");
      expect(JSON.stringify(message)).not.toContain("It is left " + "running");
    } finally {
      server.stop(true);
    }
  });

  test("closes one issue through the bridge with the worker's repository", async () => {
    const calls: Array<{ repoDir: string; repository: string; number: number }> = [];
    const { server, root, url } = await startServer({
      issues: {
        closeIssue: async (request) => {
          calls.push({
            repoDir: request.repoDir,
            repository: request.repository,
            number: request.number,
          });
        },
      },
    });
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "closeIssue", number: 8 })) as Record<
        string,
        unknown
      >;
      expect(message).toEqual({ type: "issuesClosed", number: 8, ok: true });
      expect(calls).toEqual([{ repoDir: resolve(root), repository: "acme/fixture", number: 8 }]);
    } finally {
      server.stop(true);
    }
  });

  test("reports a refused closure without a generic error", async () => {
    const { server, root, url } = await startServer({
      issues: {
        closeIssue: async () => {
          throw new Error("Could not close issue #8: HTTP 403: Resource not accessible");
        },
      },
    });
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "closeIssue", number: 8 })) as Record<
        string,
        unknown
      >;
      expect(message).toEqual({
        type: "issuesClosed",
        number: 8,
        ok: false,
        message: "Could not close issue #8: HTTP 403: Resource not accessible",
      });
    } finally {
      server.stop(true);
    }
  });

  test("refuses a close request without a number or without an origin", async () => {
    const { server, url } = await startServer();

    try {
      expect(await exchange(url, { type: "closeIssue" })).toEqual({
        type: "error",
        message: "Closing an issue needs its number.",
      });
      expect(await exchange(url, { type: "closeIssue", number: 8 })).toEqual({
        type: "issuesClosed",
        number: 8,
        ok: false,
        message: "This checkout has no GitHub origin.",
      });
    } finally {
      server.stop(true);
    }
  });
});

/** A fixture root inside `.devboard/.tmp`, kept for the shared cleanup. */
async function detachedRoot(): Promise<string> {
  const base = join(import.meta.dir, "..", ".tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "detached-app-"));
  temporaryDirectories.push(root);
  return root;
}

/** The detached owner a run key has, when it is still published. */
function detachedOwner(root: string, kind: string, key: string): number | undefined {
  const state = readDetachedRunState(detachedRunDirectory(join(root, "state"), root, kind, key));
  return state?.owner?.pid;
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(25);
  }
}

/**
 * Replaces a dashboard the way the launcher does: the handoff event leaves,
 * the old server stops without ending its detached runs, and a new app in the
 * same process adopts them from the same state directory.
 */
async function replaceDashboard(
  first: { server: Server<unknown>; url: string; root: string },
  options: Parameters<typeof startServer>[0],
) {
  const tab = await watchFrames(first.url);
  tab.send({ type: "restartServer" });
  await tab.waitFor((frame) => frame.type === "serverRestarting", "the restart handoff");
  tab.close();
  first.server.stop(true);
  return startServer({ ...options, root: first.root });
}

/** The object `startServer` hands back to the detached-run tests. */
interface StartedServer {
  server: Server<unknown>;
  adrDir: string;
  root: string;
  url: string;
}

/** A started dashboard whose installer hooks are reachable from the test. */
interface StartedDashboard {
  server: { stop(closeActiveConnections?: boolean): void } & InstallerHooks;
  adrDir: string;
  root: string;
  url: string;
}

describe("detached runs", () => {
  test("a goal creation answers and finishes on the same run after a replacement", async () => {
    const root = await detachedRoot();
    const log = join(root, "agent.log");
    const command = `bun ${STUB_AGENT} --create-goal --goal=${join(root, "GOAL.md")} --log=${log}`;
    const options = { root, agentCommand: command, restart: () => undefined };
    const first = await startServer(options);
    const tab = await watchFrames(first.url);
    let second: StartedServer | undefined;
    try {
      tab.send({ type: "createGoal" });
      await tab.waitFor((frame) => frame.type === "goalCreationStarted", "the creation start");
      const question = await tab.waitFor((frame) => frame.type === "question", "the question");
      const owner = detachedOwner(root, "goal", "creation");
      expect(owner).toBeDefined();
      expect(pidAlive(owner!)).toBe(true);
      second = await replaceDashboard(first, options);
      const after = await watchFrames(second.url);
      try {
        const replay = await after.waitFor(
          (frame) => frame.type === "question" && String(frame.id) === String(question.id),
          "the replayed question",
        );
        expect(detachedOwner(root, "goal", "creation")).toBe(owner);
        expect(pidAlive(owner!)).toBe(true);
        after.send({ type: "answer", id: replay.id, value: "Alpha" });
        const stopped = await after.waitFor(
          (frame) => frame.type === "goalCreationStopped",
          "the creation stop",
        );
        expect(stopped.completed).toBe(true);
        expect(stopped.text).toBe("# Created goal\n\nThe agent wrote this.");
        expect(await readFile(join(root, "GOAL.md"), "utf8")).toBe(
          "# Created goal\n\nThe agent wrote this.",
        );
        await waitForCondition(
          () => !pidAlive(owner!),
          "the finished creation owner to exit",
        );
      } finally {
        after.close();
      }
    } finally {
      tab.close();
      first.server.stop(true);
      second?.server.stop(true);
    }
  }, 30_000);

  test("a goal revision answers and finishes on the same run after a replacement", async () => {
    const root = await detachedRoot();
    const log = join(root, "agent.log");
    const command = `bun ${STUB_AGENT} --revise-goal --goal=${join(root, "GOAL.md")} --log=${log}`;
    const options = { root, agentCommand: command, goalText: "# Goal\n\nFirst.\n", restart: () => undefined };
    const first = await startServer(options);
    const tab = await watchFrames(first.url);
    let second: StartedServer | undefined;
    try {
      tab.send({ type: "reviseGoal", request: "tighten the scope" });
      await tab.waitFor((frame) => frame.type === "goalRevisionStarted", "the revision start");
      const question = await tab.waitFor((frame) => frame.type === "question", "the question");
      const owner = detachedOwner(root, "goal", "revision");
      expect(owner).toBeDefined();
      expect(pidAlive(owner!)).toBe(true);
      second = await replaceDashboard(first, options);
      const after = await watchFrames(second.url);
      try {
        const replay = await after.waitFor(
          (frame) => frame.type === "question" && String(frame.id) === String(question.id),
          "the replayed question",
        );
        expect(pidAlive(owner!)).toBe(true);
        after.send({ type: "answer", id: replay.id, value: "Alpha" });
        const stopped = await after.waitFor(
          (frame) => frame.type === "goalRevisionStopped",
          "the revision stop",
        );
        expect(stopped.completed).toBe(true);
        expect(stopped.text).toBe("# Revised goal\n\nThe agent rewrote this.");
      } finally {
        after.close();
      }
    } finally {
      tab.close();
      first.server.stop(true);
      second?.server.stop(true);
    }
  }, 30_000);

  test("a skills preparation answers and finishes on the same run after a replacement", async () => {
    const root = await detachedRoot();
    const log = join(root, "agent.log");
    const command = `bun ${STUB_AGENT} --prepare-skills --questions=1 --log=${log}`;
    const options = { root, agentCommand: command, goalText: "# Goal\n\nFirst.\n", restart: () => undefined };
    const first = await startServer(options);
    const tab = await watchFrames(first.url);
    let second: StartedServer | undefined;
    try {
      tab.send({ type: "prepareSkills" });
      await tab.waitFor(
        (frame) => frame.type === "skillsPreparationStarted",
        "the preparation start",
      );
      const question = await tab.waitFor((frame) => frame.type === "question", "the question");
      const owner = detachedOwner(root, "goal", "skills");
      expect(owner).toBeDefined();
      expect(pidAlive(owner!)).toBe(true);
      second = await replaceDashboard(first, options);
      const after = await watchFrames(second.url);
      try {
        const replay = await after.waitFor(
          (frame) => frame.type === "question" && String(frame.id) === String(question.id),
          "the replayed question",
        );
        expect(pidAlive(owner!)).toBe(true);
        after.send({ type: "answer", id: replay.id, value: "Alpha" });
        const stopped = await after.waitFor(
          (frame) => frame.type === "skillsPreparationStopped",
          "the preparation stop",
        );
        expect(stopped.completed).toBe(true);
      } finally {
        after.close();
      }
    } finally {
      tab.close();
      first.server.stop(true);
      second?.server.stop(true);
    }
  }, 30_000);

  test("a manual ADR run answers and finishes on the same run after a replacement", async () => {
    const root = await detachedRoot();
    const log = join(root, "agent.log");
    const command = `bun ${STUB_AGENT} --questions=1 --log=${log}`;
    const options = {
      root,
      agentCommand: command,
      adrSource: pendingRecord("0001-first.md", "First"),
      restart: () => undefined,
    };
    const first = await startServer(options);
    const tab = await watchFrames(first.url);
    let second: StartedServer | undefined;
    try {
      tab.send({ type: "startRun" });
      await tab.waitFor((frame) => frame.type === "runStarted", "the run start");
      const question = await tab.waitFor((frame) => frame.type === "question", "the question");
      const owner = detachedOwner(root, "adr", "0001-first.md");
      expect(owner).toBeDefined();
      expect(pidAlive(owner!)).toBe(true);
      second = await replaceDashboard(first, options);
      const after = await watchFrames(second.url);
      try {
        const replay = await after.waitFor(
          (frame) => frame.type === "question" && String(frame.id) === String(question.id),
          "the replayed question",
        );
        expect(pidAlive(owner!)).toBe(true);
        after.send({ type: "answer", id: replay.id, value: "Alpha" });
        const stopped = await after.waitFor(
          (frame) => frame.type === "runStopped",
          "the run stop",
        );
        expect(stopped.resolved).toBe(true);
        await waitForCondition(() => !pidAlive(owner!), "the finished ADR owner to exit");
      } finally {
        after.close();
      }
    } finally {
      tab.close();
      first.server.stop(true);
      second?.server.stop(true);
    }
  }, 30_000);

  test("a lifecycle lane answers and finishes on the same run after a replacement", async () => {
    const root = await detachedRoot();
    const log = join(root, "agent.log");
    const command = `bun ${STUB_AGENT} --questions=1 --log=${log}`;
    const epic: OpenEpic = {
      number: 42,
      title: "Active epic",
      url: "https://example.test/issues/42",
    };
    const options = {
      root,
      agentCommand: command,
      prepareSkill: true,
      goalText: "# Goal\n\nImplement the active epic.\n",
      tracker: async () => epic,
      restart: () => undefined,
    };
    const first = await startServer(options);
    const tab = await watchFrames(first.url);
    let second: StartedServer | undefined;
    try {
      tab.send({ type: "startLifecycle" });
      await tab.waitFor(
        (frame) => frame.type === "lifecycleState" && frame.stage === "implementation",
        "the implementation stage",
        20_000,
      );
      const question = await tab.waitFor(
        (frame) => frame.type === "question" && typeof frame.lane === "string",
        "the lane question",
        20_000,
      );
      const lane = String(question.lane);
      const owner = detachedOwner(root, "lane", lane);
      expect(owner).toBeDefined();
      expect(pidAlive(owner!)).toBe(true);
      second = await replaceDashboard(first, options);
      const after = await watchFrames(second.url);
      try {
        const replayed = await after.waitFor(
          (frame) =>
            frame.type === "laneState" &&
            Array.isArray(frame.lanes) &&
            (frame.lanes as Array<Record<string, unknown>>).some(
              (entry) => entry.id === lane && entry.question !== null,
            ),
          "the replayed lane question",
        );
        expect(pidAlive(owner!)).toBe(true);
        const entry = (replayed.lanes as Array<Record<string, unknown>>).find(
          (candidate) => candidate.id === lane,
        );
        const pending = entry?.question as Record<string, unknown> | undefined;
        after.send({ type: "answer", id: pending?.id, value: "Alpha", lane });
        await after.waitFor(
          (frame) =>
            frame.type === "laneState" &&
            Array.isArray(frame.lanes) &&
            (frame.lanes as Array<Record<string, unknown>>).some(
              (candidate) => candidate.id === lane && candidate.question === null,
            ),
          "the lane's answer to land",
        );
        after.send({ type: "stopLifecycle" });
        await waitForCondition(() => !pidAlive(owner!), "the lane owner to exit");
      } finally {
        after.close();
      }
    } finally {
      tab.close();
      first.server.stop(true);
      second?.server.stop(true);
    }
  }, 40_000);

  test("an Ask conversation keeps its turn and answers it after a replacement", async () => {
    const root = await detachedRoot();
    const log = join(root, "agent.log");
    const command = `bun ${STUB_AGENT} --ask --log=${log} --ask-delay-ms=1200`;
    const options = { root, agentCommand: command, restart: () => undefined };
    const context = {
      route: "/boards/42",
      url: "http://127.0.0.1:8080/boards/42",
      selector: "footer > span.status-item:nth-of-type(2)",
      viewport: "1440x900 @1x",
      captured_at: "2026-10-27T10:00:00.000Z",
      visible_text: "issues working (3)",
      dom_excerpt: '<span class="status-item">issues working (3)</span>',
    };
    const first = await startServer(options);
    const tab = await watchFrames(first.url);
    let second: StartedServer | undefined;
    try {
      tab.send({
        type: "ask",
        conversationId: "detached-conversation",
        question: "Which file renders the status bar?",
        context,
      });
      await tab.waitFor((frame) => frame.type === "askChunk", "the first answer chunk", 20_000);
      const owner = detachedOwner(root, "ask", "detached-conversation");
      expect(owner).toBeDefined();
      expect(pidAlive(owner!)).toBe(true);
      second = await replaceDashboard(first, options);
      const after = await watchFrames(second.url);
      try {
        after.send({
          type: "ask",
          conversationId: "detached-conversation",
          question: "Which file renders the status bar?",
          context,
        });
        const done = await after.waitFor(
          (frame) => frame.type === "askDone",
          "the continued answer",
        );
        expect(done.conversationId).toBe("detached-conversation");
        expect(pidAlive(owner!)).toBe(true);

        after.send({
          type: "ask",
          conversationId: "detached-conversation",
          question: "And the count?",
          context,
        });
        const secondDone = await after.waitFor(
          (frame) =>
            frame.type === "askDone" && frame.conversationId === "detached-conversation",
          "the second turn",
        );
        expect(secondDone.type).toBe("askDone");
        after.send({ type: "closeAsk", conversationId: "detached-conversation" });
        await waitForCondition(() => !pidAlive(owner!), "the closed Ask owner to exit");
      } finally {
        after.close();
      }
    } finally {
      tab.close();
      first.server.stop(true);
      second?.server.stop(true);
    }
  }, 40_000);
});

const DRAFT_PATH = ".devboard/goal-proposals/prepared.md";

/** One running draft elaboration, its connected tab, and the owner peer. */
async function startDraftElaboration(root: string): Promise<{
  started: StartedDashboard;
  tab: WatchedFrames;
  stateDir: string;
  peer: number;
  startedAt: string | null | undefined;
}> {
  await mkdir(join(root, ".devboard", "goal-proposals"), { recursive: true });
  await writeFile(
    join(root, ".devboard", "goal-proposals", "prepared.md"),
    "# Prepared draft\n\n> Unprocessed draft. STUB-HANG\n",
  );
  const started = await startServer({
    root,
    agentCommand: `bun ${STUB_AGENT} --goal-draft --log=${join(root, "agent.log")}`,
  });
  const tab = await watchFrames(started.url);
  const stateDir = join(root, "state");
  try {
    tab.send({ type: "startGoalDraft", path: DRAFT_PATH });
    await tab.waitFor(
      (frame) =>
        frame.type === "issuesDraftState" &&
        (frame.draft as { status?: unknown } | undefined)?.status === "running",
      "the running elaboration",
    );
    await waitForCondition(
      () => readGoalDraftOwnerState(stateDir, root, DRAFT_PATH)?.peer != null,
      "the draft owner's peer",
    );
    const owner = readGoalDraftOwnerState(stateDir, root, DRAFT_PATH);
    return {
      started,
      tab,
      stateDir,
      peer: owner?.peer?.pid ?? 0,
      startedAt: owner?.run.startedAt,
    };
  } catch (error) {
    tab.close();
    started.server.stop(true);
    throw error;
  }
}

function draftCommands(stateDir: string, root: string): string[] {
  const control = goalDraftControlDirectory(stateDir, root, DRAFT_PATH);
  if (!existsSync(control)) return [];
  return readdirSync(control).map((name) => readFileSync(join(control, name), "utf8"));
}

/**
 * The installer's automatic update prepares the replacement without a click,
 * then stops. That shutdown is not terminal: the successor owns the draft and
 * the detached runs. An operator Stop takes the same shutdown without the
 * preparation, so it interrupts the draft and removes both handoffs.
 */
describe("prepared replacement handoff", () => {
  test(
    "an automatic replacement leaves the draft and detached handoffs to the successor",
    async () => {
      const root = await detachedRoot();
      const { started, tab, stateDir, peer, startedAt } = await startDraftElaboration(root);
      let firstStopped = false;
      let second: StartedDashboard | undefined;
      try {
        expect(pidAlive(peer)).toBe(true);

        started.server.prepareReplacement();
        started.server.stop(true);
        firstStopped = true;

        expect(existsSync(goalDraftHandoffPath(stateDir, root))).toBe(true);
        expect(existsSync(detachedRunHandoffPath(stateDir, root))).toBe(true);
        expect(draftCommands(stateDir, root)).not.toContain('{"type":"interrupt"}\n');
        expect(pidAlive(peer)).toBe(true);

        second = await startServer({
          root,
          agentCommand: `bun ${STUB_AGENT} --goal-draft --log=${join(root, "agent.log")}`,
        });
        const list = (await exchange(second.url, { type: "getGoalDrafts" })) as Record<
          string,
          unknown
        >;
        const adopted = (list.runs as Record<string, unknown>[]).find(
          (run) => run.path === DRAFT_PATH,
        );
        expect(adopted?.status).toBe("running");
        expect(adopted?.startedAt).toBe(startedAt);
        expect(pidAlive(peer)).toBe(true);
      } finally {
        tab.close();
        if (!firstStopped) started.server.stop(true);
        second?.server.stop(true);
      }
      await waitForCondition(() => !pidAlive(peer), "the adopted peer to exit");
    },
    40_000,
  );

  test(
    "an operator Stop interrupts the elaboration and removes both handoffs",
    async () => {
      const root = await detachedRoot();
      const { started, tab, stateDir, peer } = await startDraftElaboration(root);
      let stopped = false;
      try {
        expect(pidAlive(peer)).toBe(true);

        started.server.stop(true);
        stopped = true;

        expect(existsSync(goalDraftHandoffPath(stateDir, root))).toBe(false);
        expect(existsSync(detachedRunHandoffPath(stateDir, root))).toBe(false);
        expect(draftCommands(stateDir, root)).toContain('{"type":"interrupt"}\n');
        await waitForCondition(() => !pidAlive(peer), "the interrupted peer to exit");
      } finally {
        tab.close();
        if (!stopped) started.server.stop(true);
      }
    },
    40_000,
  );
});

describe("Discover checkout lifecycle", () => {
  test(
    "a staging-preparation failure releases the checkout and never blocks Flow",
    async () => {
      const root = guardDirectory("staging-failure");
      sourceCheckout(root);
      seedRetainedProject(root, "octocat", "Hello-World", "hello");
      const broken = cloneSource("staging-failure-source", true);
      const clones = cloneRecorder(broken);
      const started = await startServer({
        root,
        agentCommand: `bun ${STUB_AGENT} --flow-goal --log=${join(root, "agent.log")}`,
        discoverClone: clones.runner,
      });
      const tab = await watchFrames(started.url);
      try {
        tab.send({ type: "discoverRemote", url: "https://github.com/coollabsio/coolify" });
        const failed = await tab.waitFor(
          (frame) =>
            frame.type === "discoverError" && String(frame.message).includes("Could not prepare"),
          "the staging failure",
        );
        expect(String(failed.message)).toContain("staging directory");
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotRepository(frame) === "coollabsio/coolify" &&
            !snapshotCheckout(frame),
          "the released Discover snapshot",
        );
        expect(stagingEntries(root)).toEqual([]);
        expect(
          existsSync(
            remoteProjectDirectory(
              remoteScratchRoot(join(root, "state")),
              "coollabsio",
              "coolify",
            ),
          ),
        ).toBe(false);

        const flowMark = tab.waitFor(
          (frame) => frame.type === "flowGoalStarted",
          "a Flow start after the failed Discover run",
        );
        tab.send({ type: "createFlowGoal" });
        await flowMark;
        expect(
          tab.frames().some(
            (frame) =>
              frame.type === "error" &&
              String(frame.message).toLowerCase().includes("is active"),
          ),
        ).toBe(false);
      } finally {
        tab.close();
        started.server.stop(true);
      }
    },
    60_000,
  );

  test(
    "a live Discover run refuses every remote target change and keeps its checkout",
    async () => {
      const root = guardDirectory("live-target-change");
      sourceCheckout(root);
      const hello = seedRetainedProject(root, "octocat", "Hello-World", "hello");
      seedRetainedProject(root, "octocat", "Second", "second");
      const source = cloneSource("live-target-change-source");
      const clones = cloneRecorder(source);
      const started = await startServer({
        root,
        agentCommand:
          `bun ${STUB_AGENT} --discover --discover-no-exit ` +
          `--log=${join(root, "agent.log")}`,
        discoverClone: clones.runner,
      });
      const tab = await watchFrames(started.url);
      try {
        tab.send({ type: "switchDiscoverRemote", url: "https://github.com/octocat/Hello-World" });
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotRepository(frame) === "octocat/Hello-World",
          "the switched remote target",
        );
        const runMark = tab.mark();
        tab.send({ type: "discoverProject" });
        await tab.waitFor(
          (frame) => frame.type === "discoverStarted",
          "the remote Discover run",
          15_000,
          runMark,
        );
        await tab.waitFor(
          (frame) => frame.type === "discoverState" && snapshotCheckout(frame),
          "the live remote checkout",
          15_000,
          runMark,
        );
        expect(clones.calls.at(-1)?.argv).toContain("https://github.com/octocat/Hello-World");

        for (const command of [
          { type: "switchDiscoverRemote", url: "https://github.com/octocat/Second" },
          { type: "removeDiscoverRemote", url: "https://github.com/octocat/Hello-World" },
          { type: "clearDiscoverRemote" },
        ]) {
          const from = tab.mark();
          tab.send(command);
          const refused = await tab.waitFor(
            (frame) =>
              frame.type === "discoverError" && String(frame.message).includes("Discover run"),
            `the refusal of ${command.type}`,
            15_000,
            from,
          );
          expect(String(refused.message)).toContain("Stop it");
        }
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotRepository(frame) === "octocat/Hello-World" &&
            snapshotCheckout(frame),
          "the unchanged live target",
        );
        expect(existsSync(hello)).toBe(true);
        expect(stagingEntries(root)).toHaveLength(1);

        const stopMark = tab.mark();
        tab.send({ type: "stopDiscover" });
        await tab.waitFor(
          (frame) => frame.type === "discoverStopped",
          "the run stop",
          15_000,
          stopMark,
        );
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotRepository(frame) === "octocat/Hello-World" &&
            !snapshotCheckout(frame),
          "the released checkout",
          15_000,
          stopMark,
        );
        expect(stagingEntries(root)).toEqual([]);

        const switchMark = tab.mark();
        tab.send({ type: "switchDiscoverRemote", url: "https://github.com/octocat/Second" });
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" && snapshotRepository(frame) === "octocat/Second",
          "the switched target after Stop",
          15_000,
          switchMark,
        );
        const secondMark = tab.mark();
        const cloneCount = clones.calls.length;
        tab.send({ type: "discoverProject" });
        await tab.waitFor(
          (frame) => frame.type === "discoverStarted",
          "the second run",
          15_000,
          secondMark,
        );
        expect(clones.calls.length).toBeGreaterThan(cloneCount);
        expect(clones.calls.at(-1)?.argv).toContain("https://github.com/octocat/Second");
      } finally {
        tab.close();
        started.server.stop(true);
      }
    },
    90_000,
  );
});

describe("Discover remote target changes", () => {
  test(
    "switch, removal, and clear leave no checkout and clone the next command again",
    async () => {
      const root = guardDirectory("target-change");
      sourceCheckout(root);
      const hello = seedRetainedProject(root, "octocat", "Hello-World", "hello");
      const second = seedRetainedProject(root, "octocat", "Second", "second");
      const source = cloneSource("target-change-source");
      const clones = cloneRecorder(source);
      const started = await startServer({
        root,
        agentCommand:
          `bun ${STUB_AGENT} --discover --discover-no-exit ` +
          `--log=${join(root, "agent.log")}`,
        discoverClone: clones.runner,
      });
      const tab = await watchFrames(started.url);
      try {
        let mark = tab.mark();
        tab.send({
          type: "switchDiscoverRemote",
          url: "https://github.com/octocat/Hello-World",
        });
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotRepository(frame) === "octocat/Hello-World" &&
            !snapshotCheckout(frame),
          "the switched target",
          15_000,
          mark,
        );

        mark = tab.mark();
        tab.send({
          type: "removeDiscoverRemote",
          url: "https://github.com/octocat/Second",
        });
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotRepository(frame) === "octocat/Hello-World",
          "the removal",
          15_000,
          mark,
        );
        expect(existsSync(second)).toBe(false);
        expect(existsSync(hello)).toBe(true);

        mark = tab.mark();
        tab.send({ type: "clearDiscoverRemote" });
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotTargetKind(frame) === "host" &&
            !snapshotCheckout(frame),
          "the cleared target",
          15_000,
          mark,
        );

        mark = tab.mark();
        tab.send({
          type: "switchDiscoverRemote",
          url: "https://github.com/octocat/Hello-World",
        });
        await tab.waitFor(
          (frame) =>
            frame.type === "discoverState" &&
            snapshotRepository(frame) === "octocat/Hello-World" &&
            !snapshotCheckout(frame),
          "the restored target",
          15_000,
          mark,
        );

        const runMark = tab.mark();
        const cloneCount = clones.calls.length;
        tab.send({ type: "discoverProject" });
        await tab.waitFor(
          (frame) => frame.type === "discoverStarted",
          "the cloned run",
          15_000,
          runMark,
        );
        expect(clones.calls.length).toBe(cloneCount + 1);
        expect(clones.calls.at(-1)?.argv).toContain(
          "https://github.com/octocat/Hello-World",
        );
      } finally {
        tab.close();
        started.server.stop(true);
      }
    },
    60_000,
  );
});
