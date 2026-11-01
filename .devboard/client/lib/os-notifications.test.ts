import { afterEach, expect, test } from "bun:test";
import {
  collectPendingQuestions,
  ENABLED_KEY,
  OsNotificationController,
  type DiscoverQuestionSource,
  type FlowQuestionSource,
  type GoalQuestionSource,
  type IssuesQuestionSource,
  type OsNotificationEnvironment,
  type OsNotificationMessage,
  type PendingQuestion,
  type QuestionSources,
} from "./os-notifications.svelte";
import { notifications } from "./notifications.svelte";
import type { Lane, RunQuestion } from "./types";

interface Storage {
  values: Map<string, string>;
}

class FakeChannel implements OsNotificationEnvironment {
  permissionValue: "default" | "granted" | "denied" | "unsupported" = "default";
  requestResult: "default" | "granted" | "denied" | "unsupported" = "granted";
  requests = 0;
  shown: OsNotificationMessage[] = [];

  constructor(readonly storage: Storage = { values: new Map() }) {}

  permission(): "default" | "granted" | "denied" | "unsupported" {
    return this.permissionValue;
  }

  async requestPermission(): Promise<"default" | "granted" | "denied" | "unsupported"> {
    this.requests += 1;
    return this.requestResult;
  }

  show(message: OsNotificationMessage): void {
    this.shown.push(message);
  }

  readEnabled(): boolean {
    return this.storage.values.get(ENABLED_KEY) === "1";
  }

  writeEnabled(enabled: boolean): void {
    if (enabled) this.storage.values.set(ENABLED_KEY, "1");
    else this.storage.values.delete(ENABLED_KEY);
  }
}

function question(id: number | string, message: string): RunQuestion {
  return { id, message, options: [] };
}

function goalSource(overrides: Partial<GoalQuestionSource> = {}): GoalQuestionSource {
  return {
    question: null,
    lanes: [],
    creationActive: false,
    revisionActive: false,
    skillsPrepActive: false,
    manualRunActive: false,
    runFile: null,
    runTitle: null,
    laneLabel: (lane: Lane) =>
      lane.kind === "generation" ? "Epic generation" : `Epic #${lane.epic?.number ?? ""}`,
    ...overrides,
  };
}

function discoverSource(overrides: Partial<DiscoverQuestionSource> = {}): DiscoverQuestionSource {
  return {
    question: null,
    agentQuestions: {},
    agents: [],
    runId: null,
    active: false,
    ...overrides,
  };
}

function flowSource(overrides: Partial<FlowQuestionSource> = {}): FlowQuestionSource {
  return {
    sessionId: null,
    status: "running",
    question: null,
    goalCreation: null,
    conversation: null,
    widgets: [],
    ...overrides,
  };
}

function issuesSource(overrides: Partial<IssuesQuestionSource> = {}): IssuesQuestionSource {
  return { agents: [], draftRuns: {}, drafts: [], ...overrides };
}

function sources(overrides: Partial<QuestionSources> = {}): QuestionSources {
  return {
    goal: goalSource(),
    discover: discoverSource(),
    flow: flowSource(),
    issues: issuesSource(),
    ...overrides,
  };
}

function lane(id: string, pending: RunQuestion | null): Lane {
  return {
    id,
    kind: "implementation",
    epic: { number: 17, title: "Notifications", url: "https://example.test/17" },
    record: null,
    attempt: 1,
    status: "running",
    activity: [],
    question: pending,
  };
}

/** Marks the browser grant and the stored choice, then hands back the channel. */
function granted(channel: FakeChannel): FakeChannel {
  channel.permissionValue = "granted";
  channel.storage.values.set(ENABLED_KEY, "1");
  return channel;
}

afterEach(() => {
  notifications.clear();
});

test("before any grant the control reads off and names OS notifications", () => {
  const channel = new FakeChannel();
  const controller = new OsNotificationController(channel);
  expect(controller.state).toBe("off");
  expect(controller.label).toBe("OS notifications off");
  expect(controller.label.toLowerCase()).toContain("os notifications");
});

test("a click that grants permission turns the control on", async () => {
  const channel = new FakeChannel();
  const controller = new OsNotificationController(channel);
  channel.requestResult = "granted";
  const clicking = controller.toggle();
  channel.permissionValue = "granted";
  await clicking;
  expect(channel.requests).toBe(1);
  expect(controller.state).toBe("on");
  expect(controller.label).toBe("OS notifications on");
  expect(channel.storage.values.get(ENABLED_KEY)).toBe("1");
});

test("a denied or blocked browser reads as blocked", async () => {
  const denied = new FakeChannel();
  denied.permissionValue = "denied";
  const controller = new OsNotificationController(denied);
  expect(controller.state).toBe("blocked");
  expect(controller.label).toBe("OS notifications blocked");
  await controller.toggle();
  expect(denied.requests).toBe(0);

  const unsupported = new FakeChannel();
  unsupported.permissionValue = "unsupported";
  expect(new OsNotificationController(unsupported).state).toBe("blocked");
});

test("a dismissed prompt leaves the control off", async () => {
  const channel = new FakeChannel();
  channel.requestResult = "default";
  const controller = new OsNotificationController(channel);
  await controller.toggle();
  expect(channel.requests).toBe(1);
  expect(controller.state).toBe("off");
  expect(channel.storage.values.has(ENABLED_KEY)).toBe(false);
});

test("a granted click toggles on and off without another prompt", async () => {
  const channel = new FakeChannel();
  channel.permissionValue = "granted";
  const controller = new OsNotificationController(channel);
  await controller.toggle();
  expect(controller.state).toBe("on");
  expect(channel.requests).toBe(0);
  await controller.toggle();
  expect(controller.state).toBe("off");
  expect(channel.requests).toBe(0);
});

test("the on choice survives a reload and blocked is read from the browser", async () => {
  const storage: Storage = { values: new Map() };
  const first = new FakeChannel(storage);
  first.permissionValue = "granted";
  const before = new OsNotificationController(first);
  await before.toggle();
  expect(before.state).toBe("on");

  const reloaded = new FakeChannel(storage);
  reloaded.permissionValue = "granted";
  expect(new OsNotificationController(reloaded).state).toBe("on");

  // The stored choice is not a grant: the browser's refused permission wins.
  const blocked = new FakeChannel(storage);
  blocked.permissionValue = "denied";
  expect(new OsNotificationController(blocked).state).toBe("blocked");
});

test("turning the control on announces pending questions exactly once", async () => {
  const channel = new FakeChannel();
  channel.permissionValue = "granted";
  const controller = new OsNotificationController(channel);
  const pending = collectPendingQuestions(
    sources({
      goal: goalSource({
        lanes: [lane("lane-a", question(1, "Which epic first?"))],
      }),
      flow: flowSource({ sessionId: "s1", question: question(2, "Which scope?") }),
    }),
  );
  controller.observe(pending);
  expect(channel.shown).toHaveLength(0);

  await controller.toggle();
  expect(channel.shown).toHaveLength(2);
  controller.observe(pending);
  expect(channel.shown).toHaveLength(2);
});

test("a goal lifecycle lane raises one notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  const pending = collectPendingQuestions(
    sources({ goal: goalSource({ lanes: [lane("lane-a", question(7, "Which epic?"))] }) }),
  );
  controller.observe(pending);
  expect(channel.shown).toHaveLength(1);
  expect(channel.shown[0]?.title).toContain("Goal lane");
  expect(channel.shown[0]?.title).toContain("Epic #17");
  expect(channel.shown[0]?.body).toBe("Which epic?");
});

test("a manual goal run raises one notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        goal: goalSource({
          question: question(3, "Continue the manual run?"),
          manualRunActive: true,
          runFile: "adrs/0007-notify.md",
          runTitle: "Notify",
        }),
      }),
    ),
  );
  expect(channel.shown).toHaveLength(1);
  expect(channel.shown[0]?.title).toContain("Manual goal run");
});

test("goal creation raises one notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        goal: goalSource({ creationActive: true, question: question(4, "What is the outcome?") }),
      }),
    ),
  );
  expect(channel.shown.map((message) => message.title)).toEqual([
    "devboard · Goal creation",
  ]);
});

test("goal revision raises one notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        goal: goalSource({ revisionActive: true, question: question(5, "Which revision?") }),
      }),
    ),
  );
  expect(channel.shown[0]?.title).toContain("Goal revision");
  expect(channel.shown[0]?.body).toBe("Which revision?");
});

test("skills preparation raises one notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        goal: goalSource({ skillsPrepActive: true, question: question(6, "Overwrite the skill?") }),
      }),
    ),
  );
  expect(channel.shown[0]?.title).toContain("Skills preparation");
});

test("a Discover agent raises one notification with its own label", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        discover: discoverSource({
          active: true,
          agentQuestions: { conventions: question(8, "Which conventions?") },
          agents: [
            {
              id: "conventions",
              label: "Conventions",
              command: "conventions",
              state: "running",
              startedAt: null,
              endedAt: null,
              error: null,
              prompt: null,
            },
          ],
        }),
      }),
    ),
  );
  expect(channel.shown).toHaveLength(1);
  expect(channel.shown[0]?.title).toContain("Discover agent · Conventions");
  expect(channel.shown[0]?.body).toBe("Which conventions?");
});

test("a Flow session raises one notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(sources({ flow: flowSource({ sessionId: "s2", question: question(9, "Which file?") }) })),
  );
  expect(channel.shown[0]?.title).toContain("Flow session");
});

test("Flow goal creation raises one notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        flow: flowSource({
          sessionId: "s2",
          goalCreation: { question: question(10, "Finish the goal?") },
        }),
      }),
    ),
  );
  expect(channel.shown[0]?.title).toContain("Flow goal creation");
});

test("a Flow conversation raises one notification naming the widget", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        flow: flowSource({
          sessionId: "s2",
          conversation: { widgetId: "w1", question: question(11, "Rename the entity?") },
          widgets: [{ id: "w1", concept: "Entity naming" }],
        }),
      }),
    ),
  );
  expect(channel.shown[0]?.title).toContain("Flow conversation · Entity naming");
});

test("an issues draft elaboration raises one notification naming the draft", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        issues: issuesSource({
          draftRuns: {
            ".devboard/goal-proposals/001-question.md": {
              path: ".devboard/goal-proposals/001-question.md",
              status: "running",
              question: question(12, "Ask about scope?"),
            },
          },
          drafts: [
            { path: ".devboard/goal-proposals/001-question.md", name: "001-question.md" },
          ],
        }),
      }),
    ),
  );
  expect(channel.shown[0]?.title).toContain("Issues draft · 001-question.md");
  expect(channel.shown[0]?.body).toBe("Ask about scope?");
});

test("an issues agent raises one notification with the issue label", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        issues: issuesSource({
          agents: [
            { runId: "run-a", issueNumber: 17, startedAt: "", question: question(13, "Which scope?"), acp: null },
          ],
        }),
      }),
    ),
  );
  expect(channel.shown[0]?.title).toContain("Issues · issue #17");
});

test("each notification identifies devboard and distinguishes simultaneous questions", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        goal: goalSource({ creationActive: true, question: question(1, "First question") }),
        flow: flowSource({ sessionId: "s3", question: question(1, "Second question") }),
      }),
    ),
  );
  expect(channel.shown).toHaveLength(2);
  for (const message of channel.shown) expect(message.title.startsWith("devboard")).toBe(true);
  expect(channel.shown.map((message) => message.body).sort()).toEqual([
    "First question",
    "Second question",
  ]);
  expect(new Set(channel.shown.map((message) => message.title)).size).toBe(2);
});

test("a notification is raised while the document is visible and focused", () => {
  const scope = globalThis as unknown as { document?: unknown };
  const previous = scope.document;
  scope.document = { visibilityState: "visible", hasFocus: () => true };
  try {
    const channel = granted(new FakeChannel());
    const controller = new OsNotificationController(channel);
    controller.observe(
      collectPendingQuestions(sources({ goal: goalSource({ creationActive: true, question: question(1, "Hi") }) })),
    );
    expect(channel.shown).toHaveLength(1);
  } finally {
    scope.document = previous;
  }
});

test("repeated snapshots and reconnects never repeat a pending question", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  const pending = collectPendingQuestions(
    sources({ goal: goalSource({ creationActive: true, question: question(1, "Again?") }) }),
  );
  controller.observe(pending);
  controller.observe(pending);
  controller.observe(pending);
  expect(channel.shown).toHaveLength(1);
});

test("equal numeric ids in different runs each raise a notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(
      sources({
        issues: issuesSource({
          agents: [
            { runId: "run-a", issueNumber: 17, startedAt: "", question: question(1, "Which scope?"), acp: null },
            { runId: "run-b", issueNumber: 18, startedAt: "", question: question(1, "Which scope?"), acp: null },
          ],
        }),
      }),
    ),
  );
  expect(channel.shown).toHaveLength(2);
  expect(new Set(channel.shown.map((message) => message.title)).size).toBe(2);
});

test("a run's second question after an answer raises a new notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  const agent = (pending: RunQuestion | null): IssuesQuestionSource =>
    issuesSource({
      agents: [
        { runId: "run-a", issueNumber: 17, startedAt: "", question: pending, acp: null },
      ],
    });
  controller.observe(collectPendingQuestions(sources({ issues: agent(question(1, "First?")) })));
  controller.observe(collectPendingQuestions(sources({ issues: agent(null) })));
  controller.observe(collectPendingQuestions(sources({ issues: agent(question(2, "Second?")) })));
  expect(channel.shown.map((message) => message.body)).toEqual(["First?", "Second?"]);
});

test("answering is quiet and a question gone at first observation is silent", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  expect(
    collectPendingQuestions(sources({ goal: goalSource({ creationActive: true, question: null }) })),
  ).toHaveLength(0);
  controller.observe(collectPendingQuestions(sources()));
  expect(channel.shown).toHaveLength(0);

  controller.observe(
    collectPendingQuestions(sources({ goal: goalSource({ creationActive: true, question: question(1, "Ask?") }) })),
  );
  controller.observe(collectPendingQuestions(sources({ goal: goalSource({ creationActive: false, question: null }) })));
  expect(channel.shown).toHaveLength(1);
});

test("questions pending when the page loads raise one notification each", () => {
  const channel = new FakeChannel();
  channel.permissionValue = "granted";
  channel.storage.values.set(ENABLED_KEY, "1");
  const controller = new OsNotificationController(channel);
  expect(controller.state).toBe("on");
  controller.observe(
    collectPendingQuestions(
      sources({
        goal: goalSource({ lanes: [lane("lane-a", question(1, "Pending before load"))] }),
        issues: issuesSource({
          agents: [
            { runId: "run-a", issueNumber: 9, startedAt: "", question: question(2, "Also pending"), acp: null },
          ],
        }),
      }),
    ),
  );
  expect(channel.shown).toHaveLength(2);
});

test("no observation means no notification until the first state arrives", async () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  await Promise.resolve();
  expect(channel.shown).toHaveLength(0);
  controller.observe(collectPendingQuestions(sources({ goal: goalSource({ creationActive: true, question: question(1, "Now") }) })));
  expect(channel.shown).toHaveLength(1);
});

test("turning the channel off suppresses notifications immediately", async () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(sources({ goal: goalSource({ creationActive: true, question: question(1, "Before") }) })),
  );
  expect(channel.shown).toHaveLength(1);
  await controller.toggle();
  expect(controller.state).toBe("off");
  controller.observe(
    collectPendingQuestions(sources({ flow: flowSource({ sessionId: "s4", question: question(2, "After") }) })),
  );
  expect(channel.shown).toHaveLength(1);
});

test("a blocked browser raises no notification", () => {
  const channel = new FakeChannel();
  channel.permissionValue = "denied";
  channel.storage.values.set(ENABLED_KEY, "1");
  const controller = new OsNotificationController(channel);
  controller.observe(
    collectPendingQuestions(sources({ goal: goalSource({ creationActive: true, question: question(1, "Ignored") }) })),
  );
  expect(channel.shown).toHaveLength(0);
  expect(controller.label).toBe("OS notifications blocked");
});

test("a stopped Discover run leaves its last question unpending", () => {
  const pending = collectPendingQuestions(
    sources({
      discover: discoverSource({
        active: false,
        agentQuestions: { conventions: question(8, "Which conventions?") },
        agents: [
          {
            id: "conventions",
            label: "Conventions",
            command: "conventions",
            state: "idle",
            startedAt: null,
            endedAt: null,
            error: null,
            prompt: null,
          },
        ],
      }),
    }),
  );
  expect(pending).toHaveLength(0);
});

test("a stopped Flow session leaves its last question unpending", () => {
  const pending = collectPendingQuestions(
    sources({
      flow: flowSource({
        sessionId: "s2",
        status: "stopped",
        question: question(9, "Which file?"),
        conversation: { widgetId: "w1", question: question(11, "Rename the entity?") },
        widgets: [{ id: "w1", concept: "Entity naming" }],
      }),
    }),
  );
  expect(pending).toHaveLength(0);
});

test("errors and in-app notifications raise no OS notification", () => {
  const channel = granted(new FakeChannel());
  const controller = new OsNotificationController(channel);
  notifications.push("Connection", "error", "Could not reach the server.");
  notifications.push("Flow", "notice", "Flow restored.");
  controller.observe(collectPendingQuestions(sources()));
  expect(channel.shown).toHaveLength(0);
});

test("collecting ignores everything that is not a pending question", () => {
  const pending = collectPendingQuestions(
    sources({
      goal: goalSource({
        lanes: [lane("lane-idle", null)],
      }),
      discover: discoverSource({ active: true, agentQuestions: { conventions: null } }),
      flow: flowSource({ goalCreation: { question: null } }),
      issues: issuesSource({
        draftRuns: { "a.md": { path: "a.md", status: "running", question: null } },
      }),
    }),
  );
  expect(pending).toHaveLength(0);
});
