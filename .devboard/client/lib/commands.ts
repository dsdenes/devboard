import { TABS } from "./discover-format";
import { DEVBOARD_COMPLEXITY_TAB, DEVBOARD_SKILLS_TAB, DEVBOARD_TAB } from "./devboard.svelte";
import type { GoalStore } from "./goal.svelte";
import type { FlowStore } from "./flow.svelte";
import type { DiscoverStore } from "./discover.svelte";
import type { IssuesStore } from "./issues.svelte";
import type { LayoutStore, WorkspaceTab } from "./layout.svelte";
import type { ConnectionStore } from "./connection.svelte";
import type { NotificationStore } from "./notifications.svelte";
import { providers } from "./providers.svelte";
import { agentRegistry } from "../../server/agents/registry";
import type { Mode } from "./types";

export interface CommandDef {
  id: string;
  title: string;
  group: string;
  keywords?: string;
  shortcut?: string;
  disabled?: () => string | null;
  run: () => void | Promise<void>;
}

export interface CommandContext {
  goal: GoalStore;
  flow: FlowStore;
  discover: DiscoverStore;
  issues: IssuesStore;
  layout: LayoutStore;
  connection: ConnectionStore;
  notifications: NotificationStore;
  openTab: (mode: Mode, tab: WorkspaceTab) => void;
  closeTab: (mode: Mode, id: string) => void;
  focusLater: (mode: Mode, selector: string) => void;
  resetLayout: () => void;
  reportIssue: () => void;
  removeElement: () => void;
  redesignElement: () => void;
  cancelReport: () => void;
}

function disabledWhen(condition: boolean, reason: string): string | null {
  return condition ? reason : null;
}

/** The mode prefix that keeps every tab command's palette title unique. */
const MODE_LABELS: Record<Mode, string> = {
  goal: "Goal",
  issues: "Issues",
  flow: "Flow",
  discover: "Discover",
  devboard: "Devboard",
};

function tabId(kind: string, resourceId: string): string {
  return `${kind}:${resourceId}`;
}

/** Every palette entry; buttons use the same ids through `data-command`. */
export function buildCommands(ctx: CommandContext): CommandDef[] {
  const { goal, flow, discover, issues, layout, connection, notifications } = ctx;
  const commands: CommandDef[] = [];

  const add = (command: CommandDef): void => {
    commands.push(command);
  };

  // Navigation and shell.
  add({
    id: "view.mode.goal",
    title: "Switch to Goal",
    group: "View",
    shortcut: "Alt+1",
    run: () => layout.setMode("goal"),
  });
  add({
    id: "view.mode.issues",
    title: "Switch to Issues",
    group: "View",
    shortcut: "Alt+2",
    run: () => layout.setMode("issues"),
  });
  add({
    id: "view.mode.flow",
    title: "Switch to Flow",
    group: "View",
    shortcut: "Alt+3",
    run: () => layout.setMode("flow"),
  });
  add({
    id: "view.mode.discover",
    title: "Switch to Discover",
    group: "View",
    shortcut: "Alt+4",
    run: () => layout.setMode("discover"),
  });
  add({
    id: "view.mode.devboard",
    title: "Switch to Devboard",
    group: "View",
    shortcut: "Alt+5",
    keywords: "mcp tools catalog",
    run: () => layout.setMode("devboard"),
  });
  add({
    id: "view.theme.toggle",
    title: layout.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
    group: "View",
    run: () => layout.toggleTheme(),
  });
  add({
    id: "view.layout.reset",
    title: "Reset layout",
    group: "View",
    keywords: "restore defaults page splits theme",
    run: () => ctx.resetLayout(),
  });
  add({
    id: "app.reload",
    title: "Reload dashboard",
    group: "Application",
    disabled: () =>
      disabledWhen(
        connection.version?.replacement == null,
        "No automatic replacement needs a retry.",
      ),
    run: () => connection.requestRestart(),
  });
  add({
    id: "app.notifications.open",
    title: "Show notification history",
    group: "Application",
    run: () => notifications.openHistory(),
  });
  add({
    id: "settings.providers",
    title: "Providers",
    group: "Settings",
    keywords: "authentication api key opencode go openrouter budget fallback subscription",
    run: () => providers.openDialog(),
  });
  add({
    id: "app.report",
    title: "Report a UI issue",
    group: "Application",
    keywords: "element selection feedback panel",
    disabled: () =>
      disabledWhen(
        !connection.feedbackEnabled,
        "Harness reporting is disabled; set DEVBOARD_GITEA_URL.",
      ),
    run: () => ctx.reportIssue(),
  });
  add({
    id: "app.remove",
    title: "Remove a UI element",
    group: "Application",
    keywords: "delete element issue one click",
    disabled: () =>
      disabledWhen(
        !connection.feedbackEnabled,
        "Harness reporting is disabled; set DEVBOARD_GITEA_URL.",
      ),
    run: () => ctx.removeElement(),
  });
  add({
    id: "app.redesign",
    title: "Redesign a UI element",
    group: "Application",
    keywords: "restyle element issue design system one click",
    disabled: () =>
      disabledWhen(
        !connection.feedbackEnabled,
        "Harness reporting is disabled; set DEVBOARD_GITEA_URL.",
      ),
    run: () => ctx.redesignElement(),
  });
  add({
    id: "app.report.cancel",
    title: "Cancel the UI issue action",
    group: "Application",
    run: () => ctx.cancelReport(),
  });
  add({
    id: "app.notifications.dismiss",
    title: "Dismiss the newest open notification",
    group: "Application",
    disabled: () => disabledWhen(notifications.live.length === 0, "No notification is open."),
    run: () => {
      const newest = notifications.live[0];
      if (newest !== undefined) notifications.dismiss(newest.id);
    },
  });
  add({
    id: "app.notifications.clear",
    title: "Clear the notification history",
    group: "Application",
    disabled: () => disabledWhen(notifications.items.length === 0, "No notifications are waiting."),
    run: () => notifications.clear(),
  });
  add({
    id: "app.palette.open",
    title: "Show all commands",
    group: "Application",
    shortcut: "Ctrl+K",
    run: () => {},
  });

  // Open workspace tabs, so the palette can reach every surface.
  const tabCommands: Array<[Mode, WorkspaceTab]> = [
    ["goal", { id: "overview", kind: "overview", resourceId: "overview", title: "Implementation" }],
    ["goal", { id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADRs" }],
    ["goal", { id: "goal-document", kind: "goal-document", resourceId: "goal-document", title: "Goal document" }],
    ["goal", { id: "skills", kind: "skills", resourceId: "skills", title: "Skills" }],
    ["issues", { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" }],
    ["issues", { id: "agents", kind: "agents", resourceId: "agents", title: "Agents" }],
    ["issues", { id: "issues", kind: "queue", resourceId: "issues", title: "Issues" }],
    ["issues", { id: "runs", kind: "runs", resourceId: "runs", title: "Runs" }],
    ["issues", { id: "drafts", kind: "drafts", resourceId: "drafts", title: "Draft goals" }],
    ...agentRegistry.descriptors.map(
      (descriptor): [Mode, WorkspaceTab] => [
        "devboard",
        {
          id: descriptor.tab.id,
          kind: descriptor.tab.kind,
          resourceId: descriptor.tab.id,
          title: descriptor.tab.title,
        },
      ],
    ),
    ["flow", { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" }],
    ["flow", { id: "decisions", kind: "decisions", resourceId: "decisions", title: "Decision board" }],
    ["flow", { id: "steering", kind: "steering", resourceId: "steering", title: "Steering" }],
    ["flow", { id: "history", kind: "history", resourceId: "history", title: "History" }],
    ["discover", { id: "warnings", kind: "warnings", resourceId: "warnings", title: "Warnings" }],
  ];
  tabCommands.forEach(([mode, tab]) => {
    add({
      id: `open.${mode}.${tab.id}`,
      title: `Open ${MODE_LABELS[mode]}: ${tab.title}`,
      group: "Workspace",
      keywords: `tab ${mode}`,
      run: () => {
        layout.setMode(mode);
        ctx.openTab(mode, tab);
      },
    });
  });

  add({
    id: "devboard.tab.tools",
    title: "Open MCP tools",
    group: "Devboard",
    keywords: "catalog read-only",
    run: () => ctx.openTab("devboard", DEVBOARD_TAB),
  });

  add({
    id: "devboard.tab.skills",
    title: "Open Skills",
    group: "Devboard",
    keywords: "installed skills enabled exclusion omp",
    run: () => ctx.openTab("devboard", DEVBOARD_SKILLS_TAB),
  });

  add({
    id: "devboard.tab.complexity",
    title: "Open Complexity",
    group: "Devboard",
    keywords: "complexity metrics cyclomatic maintainability history daily",
    run: () => ctx.openTab("devboard", DEVBOARD_COMPLEXITY_TAB),
  });

  // Close commands mirror the close controls a surface renders itself.
  for (const mode of ["goal", "issues", "flow", "discover"] as Mode[]) {
    for (const tab of layout.tabs[mode]) {
      add({
        id: `tab.close.${mode}.${tab.id}`,
        title: `Close ${tab.title}`,
        group: "Workspace",
        keywords: `surface ${mode}`,
        run: () => ctx.closeTab(mode, tab.id),
      });
    }
  }

  // Issues mode.
  add({
    id: "issues.draft.new",
    title: "New goal",
    group: "Issues",
    keywords: "create propose draft goal instructions",
    run: () => {
      layout.setMode("issues");
      ctx.openTab("issues", {
        id: "drafts",
        kind: "drafts",
        resourceId: "drafts",
        title: "Draft goals",
      });
      issues.beginDraftCreate();
    },
  });
  add({
    id: "issues.start",
    title: "Start issue automation",
    group: "Issues",
    keywords: "worker begin poll implement every issue",
    disabled: () => disabledWhen(!issues.canStart, "Start is unavailable while the worker is enabled."),
    run: () => issues.start(),
  });
  add({
    id: "issues.pause",
    title: "Pause issue automation",
    group: "Issues",
    keywords: "drain active run stop polling",
    disabled: () => disabledWhen(!issues.canPause, "Pause is unavailable."),
    run: () => issues.pause(),
  });
  add({
    id: "issues.resume",
    title: "Resume issue automation",
    group: "Issues",
    keywords: "continue poll",
    disabled: () => disabledWhen(!issues.canResume, "Resume is unavailable."),
    run: () => issues.resume(),
  });
  add({
    id: "issues.stop",
    title: "Stop issue automation",
    group: "Issues",
    keywords: "kill peer release lock",
    disabled: () => disabledWhen(!issues.canStop, "Stop is unavailable."),
    run: () => issues.stop(),
  });
  add({
    id: "issues.check",
    title: "Check issues now",
    group: "Issues",
    keywords: "poll immediately bypass cooldown",
    disabled: () => disabledWhen(!issues.canCheck, "Check now is unavailable while paused or stopped."),
    run: () => issues.check(),
  });
  add({
    id: "issues.run.open",
    title: "Open the selected issues run",
    group: "Issues",
    disabled: () => disabledWhen(issues.selectedRun === null, "No run is selected."),
    run: () => {
      if (issues.selectedRun !== null) issues.openRun(issues.selectedRun);
    },
  });

  // Goal mode.
  add({
    id: "goal.adrs.open",
    title: "Open ADRs",
    group: "Goal",
    run: () => ctx.openTab("goal", { id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADRs" }),
  });
  add({
    id: "goal.document.open",
    title: "Open the goal document",
    group: "Goal",
    run: () =>
      ctx.openTab("goal", {
        id: "goal-document",
        kind: "goal-document",
        resourceId: "goal-document",
        title: "Goal document",
      }),
  });
  add({
    id: "goal.skills.open",
    title: "Show skills",
    group: "Goal",
    run: () => ctx.openTab("goal", { id: "skills", kind: "skills", resourceId: "skills", title: "Skills" }),
  });
  add({
    id: "goal.create",
    title: goal.goalReady ? "Recreate goal" : "Create goal",
    group: "Goal",
    run: () => goal.createGoal(),
  });
  add({
    id: "goal.revise",
    title: "Revise goal",
    group: "Goal",
    disabled: () => disabledWhen(goal.revisionDisabled, "A run is using the goal right now."),
    run: () => goal.reviseGoal(),
  });
  add({
    id: "goal.skills.prepare",
    title: "Prepare skills",
    group: "Goal",
    disabled: () => disabledWhen(goal.prepareDisabled, "A goal and an idle session are required."),
    run: () => goal.prepareSkills(),
  });
  add({
    id: "goal.adr.start-next",
    title: "Start the next ADR",
    group: "Goal",
    disabled: () =>
      disabledWhen(goal.next === null, "No ADR is pending.") ??
      disabledWhen(goal.runStartDisabled, "Another run is active."),
    run: () => goal.startNext(),
  });
  add({
    id: "goal.lifecycle.toggle",
    title: goal.lifecycleActive ? "Stop implementation" : "Start implementation",
    group: "Goal",
    disabled: () =>
      goal.lifecycleButtonDisabled
        ? (goal.lifecycleButtonTitle ?? "The goal and skills must be ready.")
        : null,
    run: () => goal.toggleLifecycle(),
  });
  add({
    id: "goal.lifecycle.pause",
    title: "Pause implementation",
    group: "Goal",
    disabled: () =>
      disabledWhen(!goal.lifecycleActive, "Implementation is not running.") ??
      disabledWhen(goal.lifecycle.paused, "Implementation is already paused."),
    run: () => goal.pauseLifecycle(),
  });
  add({
    id: "goal.lifecycle.resume",
    title: "Resume implementation",
    group: "Goal",
    disabled: () => disabledWhen(!goal.lifecycleActive || !goal.lifecycle.paused, "Implementation is not paused."),
    run: () => goal.resumeLifecycle(),
  });
  add({
    id: "goal.reset",
    title: "Reset implementation",
    group: "Goal",
    disabled: () => disabledWhen(goal.resetDisabled, "The connection is not open."),
    run: () => goal.armReset(),
  });
  add({
    id: "goal.reset.confirm",
    title: "Confirm implementation reset",
    group: "Goal",
    disabled: () => disabledWhen(!goal.resetArmed, "Arm the reset first."),
    run: () => goal.confirmReset(),
  });
  add({
    id: "goal.reset.cancel",
    title: "Cancel implementation reset",
    group: "Goal",
    disabled: () => disabledWhen(!goal.resetArmed, "No reset is armed."),
    run: () => goal.cancelReset(),
  });
  add({
    id: "goal.answer.submit",
    title: "Submit the answer",
    group: "Goal",
    disabled: () => disabledWhen(goal.question === null, "No question is waiting."),
    run: () => {
      if (goal.question === null) {
        ctx.openTab("goal", { id: "overview", kind: "overview", resourceId: "overview", title: "Implementation" });
        return ctx.focusLater("goal", "#goal-answer-input");
      }
      goal.submitAnswer(goal.draft);
    },
  });
  for (const record of goal.records) {
    add({
      id: `goal.adr.open.${record.file}`,
      title: `Open ADR ${record.title}`,
      group: "ADRs",
      keywords: `${record.file} ${record.status}`,
      run: () =>
        ctx.openTab("goal", {
          id: tabId("adr", record.file),
          kind: "adr",
          resourceId: record.file,
          title: record.title,
        }),
    });
    add({
      id: `goal.adr.start.${record.file}`,
      title: `Start ADR ${record.title}`,
      group: "ADRs",
      disabled: () =>
        disabledWhen(!record.pending, "The record is already resolved.") ??
        disabledWhen(goal.runStartDisabled, "Another run is active."),
      run: () => goal.startRecord(record),
    });
  }
  for (const skill of goal.skills) {
    add({
      id: `goal.skill.open.${skill.name}`,
      title: `Show skill ${skill.name}`,
      group: "Skills",
      run: () =>
        ctx.openTab("goal", {
          id: `skill:${skill.name}`,
          kind: "skill",
          resourceId: skill.name,
          title: skill.name,
        }),
    });
  }
  for (const lane of goal.lanes) {
    const label = goal.laneLabel(lane);
    add({
      id: `goal.lane.open.${lane.id}`,
      title: `Open lane ${label}`,
      group: "Lanes",
      keywords: lane.kind,
      run: () =>
        ctx.openTab("goal", {
          id: tabId("lane", lane.id),
          kind: "lane",
          resourceId: lane.id,
          title: label,
        }),
    });
    add({
      id: `goal.lane.answer.submit.${lane.id}`,
      title: `Submit the answer for lane ${label}`,
      group: "Lanes",
      disabled: () => disabledWhen(lane.question === null, "The lane has no pending question."),
      run: () => {
        const current = goal.lane(lane.id);
        if (current?.question == null) {
          ctx.focusLater("goal", `#lane-answer-${lane.id}`);
          return;
        }
        goal.submitLaneAnswer(lane.id, goal.laneDraft);
      },
    });
  }

  // Flow mode.
  add({
    id: "flow.goal.create",
    title: flow.goal.trim().length > 0 ? "Recreate flow goal" : "Create flow goal",
    group: "Flow",
    run: () => flow.createGoal(),
  });
  add({
    id: "flow.start",
    title: "Start Flow implementation",
    group: "Flow",
    disabled: () => disabledWhen(flow.startDisabled, "A flow goal and an idle session are required."),
    run: () => flow.startImplementation(),
  });
  add({
    id: "flow.stop",
    title: "Stop Flow implementation",
    group: "Flow",
    disabled: () => disabledWhen(flow.stopDisabled, "Implementation is not running."),
    run: () => flow.stopImplementation(),
  });
  add({
    id: "flow.steering.focus",
    title: "Focus Flow steering",
    group: "Flow",
    run: () => {
      ctx.openTab("flow", { id: "steering", kind: "steering", resourceId: "steering", title: "Steering" });
      return ctx.focusLater("flow", "#flow-steering-text");
    },
  });
  add({
    id: "flow.steering.send",
    title: "Send Flow steering note",
    group: "Flow",
    disabled: () => disabledWhen(flow.steeringDraft.trim().length === 0, "Type a steering note first."),
    run: () => flow.sendSteering(),
  });
  add({
    id: "flow.pr.retry",
    title: "Retry the Flow pull request",
    group: "Flow",
    disabled: () => disabledWhen(flow.prError === null, "There is no pull request error."),
    run: () => flow.retryPr(),
  });
  add({
    id: "flow.pr.ready",
    title: "Mark the Flow pull request ready",
    group: "Flow",
    disabled: () => disabledWhen(flow.readyDisabled, "Only a stopped session with a draft PR can be marked ready."),
    run: () => flow.markPrReady(),
  });
  add({
    id: "flow.pr.merge",
    title: "Merge the Flow pull request",
    group: "Flow",
    disabled: () => disabledWhen(flow.mergeDisabled, "Only a stopped session with a live PR can be merged."),
    run: () => flow.mergePr(),
  });
  add({
    id: "flow.conversation.send",
    title: "Send the conversation message",
    group: "Flow",
    disabled: () => disabledWhen(flow.conversation === null, "No conversation is open."),
    run: () => flow.sendConversation(),
  });
  add({
    id: "flow.conclusion.send",
    title: "Send the conclusion to implementation",
    group: "Flow",
    disabled: () =>
      disabledWhen(flow.conclusionDraft.trim().length === 0, "Type a conclusion first."),
    run: () => flow.sendConclusion(),
  });
  add({
    id: "flow.conversation.close",
    title: "Close the widget conversation",
    group: "Flow",
    disabled: () => disabledWhen(flow.conversation === null, "No conversation is open."),
    run: () => flow.closeConversation(),
  });
  add({
    id: "flow.diff.close",
    title: "Close the diff detail",
    group: "Flow",
    run: () => layout.activateTab("flow", "overview"),
  });
  for (const widget of flow.widgets) {
    add({
      id: `flow.widget.open.${widget.id}`,
      title: `Open widget ${widget.concept}`,
      group: "Flow widgets",
      keywords: widget.category,
      run: () =>
        ctx.openTab("flow", {
          id: tabId("widget", widget.id),
          kind: "widget",
          resourceId: widget.id,
          title: widget.concept,
        }),
    });
    add({
      id: `flow.widget.accept.${widget.id}`,
      title: `Toggle acceptance of ${widget.concept}`,
      group: "Flow widgets",
      run: () => flow.toggleWidget(widget),
    });
    add({
      id: `flow.widget.discuss.${widget.id}`,
      title: `Discuss ${widget.concept}`,
      group: "Flow widgets",
      run: () => flow.discuss(widget),
    });
    add({
      id: `flow.widget.refuse.${widget.id}`,
      title: `Refuse ${widget.concept}`,
      group: "Flow widgets",
      run: () => flow.startRefuse(widget),
    });
    add({
      id: `flow.widget.refuse.confirm.${widget.id}`,
      title: `Confirm refusing ${widget.concept}`,
      group: "Flow widgets",
      disabled: () => disabledWhen(flow.refusingId !== widget.id, "Start a refusal first."),
      run: () => flow.confirmRefuse(widget),
    });
    add({
      id: `flow.widget.refuse.cancel.${widget.id}`,
      title: `Cancel refusing ${widget.concept}`,
      group: "Flow widgets",
      disabled: () => disabledWhen(flow.refusingId !== widget.id, "No refusal is open."),
      run: () => flow.cancelRefuse(),
    });
  }
  for (const file of flow.files) {
    add({
      id: `flow.file.open.${file.path}`,
      title: `Open changed file ${file.path}`,
      group: "Flow files",
      keywords: file.status,
      run: () =>
        ctx.openTab("flow", {
          id: tabId("file", file.path),
          kind: "file",
          resourceId: file.path,
          title: file.path,
        }),
    });
  }
  for (const checkpoint of flow.checkpoints) {
    add({
      id: `flow.checkpoint.open.${checkpoint.id}`,
      title: `Open checkpoint ${checkpoint.summary}`,
      group: "Flow checkpoints",
      run: () =>
        ctx.openTab("flow", {
          id: tabId("checkpoint", checkpoint.id),
          kind: "checkpoint",
          resourceId: checkpoint.id,
          title: checkpoint.summary,
        }),
    });
  }
  for (const blocker of flow.blockers) {
    add({
      id: `flow.blocker.open.${blocker.id}`,
      title: `Open blocker ${blocker.text}`,
      group: "Flow blockers",
      run: () =>
        ctx.openTab("flow", { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" }),
    });
  }
  for (const blocker of flow.blockers.filter((entry) => !entry.dismissed)) {
    add({
      id: `flow.blocker.dismiss.${blocker.id}`,
      title: `Dismiss blocker ${blocker.text}`,
      group: "Flow blockers",
      keywords: "blocker",
      run: () => flow.dismissBlocker(blocker),
    });
  }
  for (const target of ["goal", "implementation", "conversation"] as const) {
    add({
      id: `flow.answer.submit.${target}`,
      title: `Submit the ${target} answer`,
      group: "Flow",
      disabled: () =>
        disabledWhen(
          target === "goal"
            ? flow.goalCreation?.question == null
            : target === "conversation"
              ? flow.conversation?.question == null
              : flow.question === null,
          "No question is waiting.",
        ),
      run: () => {
        const tab =
          target === "goal"
            ? { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" }
            : target === "conversation" && flow.conversation !== null
              ? {
                  id: `conversation:${flow.conversation.widgetId}`,
                  kind: "conversation",
                  resourceId: flow.conversation.widgetId,
                  title: "Widget conversation",
                }
              : { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };
        ctx.openTab("flow", tab);
        return ctx.focusLater("flow", `#flow-answer-${target}`);
      },
    });
  }

  // Discover mode.
  add({
    id: "discover.start",
    title: discover.hasArtifacts ? "Re-discover the project" : "Discover the project",
    group: "Discover",
    disabled: () => disabledWhen(discover.startDisabled, discover.startTitle ?? "A run is active."),
    run: () => discover.start(),
  });
  add({
    id: "discover.stop",
    title: "Stop the Discover run",
    group: "Discover",
    disabled: () => disabledWhen(!discover.active, "No Discover run is active."),
    run: () => discover.stop(),
  });
  add({
    id: "discover.glossary.focus",
    title: "Focus the glossary search",
    group: "Discover",
    run: () => {
      ctx.openTab("discover", { id: "glossary", kind: "glossary", resourceId: "glossary", title: "Glossary" });
      return ctx.focusLater("discover", "#discover-glossary-search");
    },
  });
  add({
    id: "discover.answer.submit",
    title: "Answer the Discover question",
    group: "Discover",
    disabled: () => disabledWhen(discover.question === null, "No question is waiting."),
    run: () => {
      if (discover.question === null) {
        ctx.openTab("discover", { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" });
        return ctx.focusLater("discover", "#discover-answer-input");
      }
      discover.answer(discover.answerDraft);
    },
  });
  for (const tab of TABS) {
    add({
      id: `discover.tab.${tab.id}`,
      title:
        tab.skill === null
          ? `Open Discover: ${tab.label}`
          : `Open Discover: ${tab.label} skill`,
      group: "Discover sections",
      run: () =>
        ctx.openTab("discover", {
          id: tab.id,
          kind: tab.skill === null ? tab.id : "skill",
          resourceId: tab.skill ?? tab.id,
          title: tab.label,
        }),
    });
  }
  return commands;
}
