/**
 * The query key of every backend resource, and the frames that belong to it.
 *
 * One key per REST operation plus its path parameters, so two surfaces that
 * show the same resource share one cache entry and one request. A frame the
 * dashboard pushes is written into the entry its type names, so a pushed
 * snapshot and a fetched one are the same data.
 */
import { REST_OPERATIONS, resourcePath } from "./rest-map";

export type Command = Record<string, unknown> & { type: string };

export type QueryKey = readonly [type: string, path: string];

/** The cache key for one command, or null when it is not a REST read. */
export function queryKeyFor(command: Command): QueryKey | null {
  const operation = REST_OPERATIONS[command.type];
  if (operation === undefined) return null;
  return [command.type, resourcePath(command, operation)];
}

interface FrameResource {
  type: string;
  param?: string;
}

/**
 * The resource a pushed frame represents, when it is a whole-resource
 * snapshot. Activity, question, and notice frames are stream events: they
 * belong to no cached resource and are only dispatched.
 */
const FRAME_RESOURCES: Readonly<Record<string, FrameResource>> = {
  versionState: { type: "getVersion" },
  project: { type: "getProject" },
  goal: { type: "getGoal" },
  records: { type: "listRecords" },
  skillsState: { type: "getSkills" },
  issuesState: { type: "getIssues" },
  issuesRun: { type: "getIssuesRun", param: "runId" },
  issuesRunMissing: { type: "getIssuesRun", param: "runId" },
  issuesDrafts: { type: "getGoalDrafts" },
  issuesDraftState: { type: "getGoalDraft", param: "path" },
  issuesDraftDetail: { type: "getGoalDraft", param: "path" },
  agentsState: { type: "getAgents" },
  agentState: { type: "getAgent", param: "id" },
  agentPromptState: { type: "getAgentPrompt", param: "id" },
  agentPromptError: { type: "getAgentPrompt", param: "id" },
  flowSnapshot: { type: "getFlow" },
  discoverState: { type: "getDiscover" },
  complexityState: { type: "getComplexity" },
  resourcesState: { type: "getResources" },
  installedSkills: { type: "getInstalledSkills" },
  providersState: { type: "getProviders" },
  mcpTools: { type: "getMcpTools" },
  inquiry: { type: "getInquiry", param: "conversationId" },
  inquiryMissing: { type: "getInquiry", param: "conversationId" },
};

/** The cache key a pushed frame belongs to, or null for a stream event. */
export function frameQueryKey(frame: Record<string, unknown>): QueryKey | null {
  if (typeof frame.type !== "string") return null;
  const resource = FRAME_RESOURCES[frame.type];
  if (resource === undefined) return null;
  const command: Command = { type: resource.type };
  if (resource.param !== undefined) {
    const value = frame[resource.param];
    if (typeof value !== "string" || value.length === 0) return null;
    command[resource.param] = value;
  }
  return queryKeyFor(command);
}

/**
 * The resources one command's answer changes. A mutation invalidates exactly
 * these, so a command that changes the issue queue never re-reads the goal
 * document.
 */
const INVALIDATED_RESOURCES: Readonly<Record<string, readonly string[]>> = {
  startIssues: ["getIssues"],
  pauseIssues: ["getIssues"],
  resumeIssues: ["getIssues"],
  stopIssues: ["getIssues"],
  checkIssues: ["getIssues"],
  answerIssues: ["getIssues"],
  closeIssue: ["getIssues", "getIssuesRun"],
  startGoalDraft: ["getGoalDrafts", "getGoalDraft"],
  stopGoalDraft: ["getGoalDrafts", "getGoalDraft"],
  deleteGoalDraft: ["getGoalDrafts", "getGoalDraft"],
  answerGoalDraft: ["getGoalDrafts", "getGoalDraft"],
  createGoal: ["getGoal"],
  reviseGoal: ["getGoal"],
  startLifecycle: ["getGoal"],
  stopLifecycle: ["getGoal"],
  pauseLifecycle: ["getGoal"],
  resumeLifecycle: ["getGoal"],
  resetImplementation: ["getGoal"],
  answer: ["getGoal"],
  prepareSkills: ["getSkills", "listRecords"],
  deleteSkill: ["getSkills", "listRecords"],
  createFlowGoal: ["getFlow"],
  cancelFlowGoal: ["getFlow"],
  startFlowImplementation: ["getFlow"],
  stopFlowImplementation: ["getFlow"],
  retryFlowPr: ["getFlow"],
  markFlowPrReady: ["getFlow"],
  mergeFlowPr: ["getFlow"],
  sendFlowSteering: ["getFlow"],
  acceptFlowWidget: ["getFlow"],
  refuseFlowWidget: ["getFlow"],
  openFlowWidget: ["getFlow"],
  closeFlowWidget: ["getFlow"],
  sendFlowConversation: ["getFlow"],
  sendFlowConclusion: ["getFlow"],
  dismissFlowBlocker: ["getFlow"],
  flowAnswer: ["getFlow"],
  startAgent: ["getAgents"],
  stopAgent: ["getAgents"],
  setAgentSettings: ["getAgents"],
  disableAgentTimer: ["getAgents"],
  refreshAgent: ["getAgents"],
  setResources: ["getResources"],
  setInstalledSkillEnabled: ["getInstalledSkills"],
  refreshProviders: ["getProviders"],
  createProvider: ["getProviders"],
  saveProvider: ["getProviders"],
  deleteProvider: ["getProviders"],
  setProviderEnabled: ["getProviders"],
  discoverProject: ["getDiscover"],
  discoverAgent: ["getDiscover"],
  discoverRemote: ["getDiscover"],
  switchDiscoverRemote: ["getDiscover"],
  removeDiscoverRemote: ["getDiscover"],
  clearDiscoverRemote: ["getDiscover"],
  stopDiscover: ["getDiscover"],
  answerDiscover: ["getDiscover"],
  confirmGlossaryTerm: ["getDiscover"],
  rejectGlossaryTerm: ["getDiscover"],
};

/** The resources one command's answer changes. */
export function invalidatedResources(type: string): readonly string[] {
  return INVALIDATED_RESOURCES[type] ?? [];
}
