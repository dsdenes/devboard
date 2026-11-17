import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// A static import cannot work here: the component and the testing library
// reach for `document` and `window` when they evaluate, and happy-dom
// registers those globals only after this module's static imports run.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { issues } = await import("../issues.svelte");
const { connection } = await import("../connection.svelte");

/** The fleet tab: the page-level `agents` surface this file mounts. */
const AGENTS = { id: "agents", kind: "agents", resourceId: "agents", title: "Agents" };

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

/** Stands in for the browser socket, so an answer dispatch is the frame sent. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = SOCKET_CLOSED;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = SOCKET_CLOSED;
  }
}

let socket: FakeSocket;

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  // The card rules live in the client's global stylesheet, which only `main.ts`
  // imports; mount the same sheet so the card geometry is what the page ships.
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(new URL("../../app.css", import.meta.url), "utf8");
  document.head.append(sheet);
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeSocket;
  connection.connect();
  const created = FakeSocket.instances[0];
  if (created === undefined) throw new Error("no socket created");
  socket = created;
  socket.readyState = SOCKET_OPEN;
});

afterAll(() => {
  connection.dispose();
  delete (globalThis as unknown as Record<string, unknown>).WebSocket;
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

afterEach(() => {
  cleanup();
  issues.snapshot = null;
  socket.sent = [];
  socket.readyState = SOCKET_OPEN;
});

const QUESTION = {
  id: 7,
  message: "Which branch should the close land on?",
  options: [{ label: "main", recommended: true }],
};

interface AgentSeed {
  runId: string;
  issueNumber: number;
  startedAt: string;
  question: unknown;
}

/** Three running agents, the middle one waiting on a question. */
const FLEET: AgentSeed[] = [
  { runId: "run-a", issueNumber: 42, startedAt: "2026-11-01T00:00:00Z", question: null },
  { runId: "run-b", issueNumber: 43, startedAt: "2026-11-01T00:00:00Z", question: QUESTION },
  { runId: "run-c", issueNumber: 44, startedAt: "sometime-unknown", question: null },
];

/** A replay frame naming one fleet, the shape the worker pushes. */
function fleet(agents: AgentSeed[]): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    repo: "dsdenes/devboard",
    lifecycle: "running",
    enabled: true,
    paused: false,
    queue: agents.map((agent) => ({
      number: agent.issueNumber,
      title: `Issue ${agent.issueNumber}`,
      url: `https://tracker.test/issues/${agent.issueNumber}`,
      createdAt: agent.startedAt,
      labels: [],
      handled: false,
      runId: null,
      agentRunId: agent.runId,
    })),
    runs: [],
    agents: agents.map((agent) => ({
      runId: agent.runId,
      issueNumber: agent.issueNumber,
      startedAt: agent.startedAt,
      question: agent.question,
      acp: null,
      harnessVersion: "1.57.7",
    })),
    workers: [],
  };
}

/** The fleet card for one run, read by the run it names. */
function card(container: HTMLElement, runId: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`.issues-agent[data-run="${runId}"]`);
  if (found === null) throw new Error(`the card for ${runId} did not render`);
  return found;
}

/** A computed length, resolving happy-dom's `calc(2 * 18.85px)` reading of `em`. */
function lengthPx(value: string): number {
  const calc = /^calc\(\s*([\d.]+)\s*\*\s*([\d.]+)px\s*\)$/.exec(value.trim());
  if (calc !== null) return Number(calc[1]) * Number(calc[2]);
  const plain = /^([\d.]+)px$/.exec(value.trim());
  return plain === null ? Number.NaN : Number(plain[1]);
}

/** The card's meta line with its markup's whitespace collapsed. */
function metaText(current: HTMLElement): string {
  const meta = current.querySelector(".issues-agent__meta");
  if (meta === null) throw new Error("the card has no meta line");
  return (meta.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function mountFleet(seeds: AgentSeed[]): Promise<HTMLElement> {
  issues.handleEvent(fleet(seeds));
  const view = render(IssuesWorkspace, { props: { tab: AGENTS } });
  await tick();
  return view.container;
}

test("the fleet header counts the cards and every card labels its activity without a state pill", async () => {
  const container = await mountFleet(FLEET);

  expect(container.querySelector('[data-testid="issues-agents-count"]')?.textContent?.trim()).toBe(
    "3 running",
  );
  // The header names the same count as the cards that render a question block.
  const asked = container.querySelector('[data-testid="issues-agents-asking"]')?.textContent?.trim();
  expect(asked).toBe("1 needs an answer");
  expect(Number.parseInt(asked ?? "", 10)).toBe(
    container.querySelectorAll('[data-testid="issues-agent-question"]').length,
  );

  for (const seed of FLEET) {
    const current = card(container, seed.runId);
    expect(
      current.querySelector(".issues-agent__activity-label")?.textContent?.trim(),
    ).toBe("Latest activity");
    const head = current.querySelector(".issues-agent__head");
    if (head === null) throw new Error("the card has no head");
    expect(head.querySelectorAll(".badge").length).toBe(0);
    expect(head.textContent ?? "").not.toContain("running");
    expect(head.textContent ?? "").not.toContain("needs answer");
  }
});

test("only the card whose agent asked renders a question block", async () => {
  const container = await mountFleet(FLEET);

  const waiting = card(container, "run-b");
  expect(waiting.getAttribute("data-asked")).toBe("true");
  expect(waiting.querySelectorAll('[data-testid="issues-agent-question"]').length).toBe(1);

  for (const runId of ["run-a", "run-c"]) {
    const silent = card(container, runId);
    expect(silent.hasAttribute("data-asked")).toBe(false);
    expect(silent.querySelectorAll('[data-testid="issues-agent-question"]').length).toBe(0);
  }
});

test("every title slot reserves two lines and a waiting card keeps its compact log", async () => {
  const container = await mountFleet(FLEET);

  for (const seed of FLEET) {
    const title = card(container, seed.runId).querySelector<HTMLElement>(".issues-agent__title");
    if (title === null) throw new Error("the card has no title");
    const style = getComputedStyle(title);
    const twoLines = 2 * Number.parseFloat(style.lineHeight) * Number.parseFloat(style.fontSize);
    expect(lengthPx(style.minHeight)).toBeGreaterThanOrEqual(twoLines - 0.5);
  }

  const waitingLog = card(container, "run-b").querySelector<HTMLElement>(".issues-activity");
  if (waitingLog === null) throw new Error("the waiting card has no activity log");
  expect(getComputedStyle(waitingLog).minHeight).toBe("64px");
});

test("an unparseable start time renders verbatim in both meta slots", async () => {
  const container = await mountFleet(FLEET);

  const text = metaText(card(container, "run-c"));
  expect(text).toContain("sometime-unknown elapsed");
  expect(text).toContain("started sometime-unknown");
});

test("answering one card sends its run id and clears only that card's question", async () => {
  const container = await mountFleet(FLEET);

  const choice = card(container, "run-b").querySelector<HTMLButtonElement>(".choice-list button");
  if (choice === null) throw new Error("the waiting card offers no choice");
  await fireEvent.click(choice);
  await tick();

  const answers = socket.sent
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.type === "answerIssues");
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    type: "answerIssues",
    id: QUESTION.id,
    value: "main",
    runId: "run-b",
  });

  const untouched = ["run-a", "run-c"].map((runId) => card(container, runId).outerHTML);
  issues.handleEvent(
    fleet(FLEET.map((seed) => (seed.runId === "run-b" ? { ...seed, question: null } : seed))),
  );
  await tick();

  const answered = card(container, "run-b");
  expect(answered.querySelectorAll('[data-testid="issues-agent-question"]').length).toBe(0);
  expect(answered.hasAttribute("data-asked")).toBe(false);
  expect(container.querySelector('[data-testid="issues-agents-asking"]')).toBeNull();
  expect(["run-a", "run-c"].map((runId) => card(container, runId).outerHTML)).toEqual(untouched);
});

test("an empty fleet renders the recovery panel and a zero count", async () => {
  const container = await mountFleet([]);

  expect(container.querySelector('[data-testid="issues-agents-empty"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="issues-agents-count"]')?.textContent?.trim()).toBe(
    "0 running",
  );
  expect(container.querySelector('[data-testid="issues-agent"]')).toBeNull();
});
