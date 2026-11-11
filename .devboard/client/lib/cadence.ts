/**
 * The one cadence table every recurring read follows.
 *
 * A resource is read only from a surface that shows it, at the cadence that
 * surface earns: the always-mounted chrome (StatusBar, ActivityBar, sidebar)
 * polls at its background cadence, the workspace body the active mode renders
 * polls its own resource at its body cadence, and a run the open page shows
 * polls at its live cadence while it reports itself running or paused. Zero
 * means that surface never reads the resource. A surface that is closed, a
 * mode that is hidden, and a hidden document issue nothing at all.
 *
 * The connection store's scheduler is the only client timer that acts on this
 * table; no surface carries its own poll interval.
 */
export type PollScope = "background" | "body" | "live";

export interface ResourceCadence {
  /** The always-mounted chrome; in milliseconds, or 0 for never. */
  background: number;
  /** The workspace body the active mode renders. */
  body: number;
  /** That body while it shows a run reporting itself running or paused. */
  live: number;
}

/**
 * Every resource the client may poll, by the REST operation that reads it.
 * The table is exhaustive: a GET this client registers has a row here, and a
 * GET with no row is a one-shot read (`ONE_SHOT_READS`).
 */
export const RESOURCE_CADENCE_MS: Readonly<Record<string, ResourceCadence>> = {
  getVersion: { background: 30_000, body: 30_000, live: 0 },
  getGoal: { background: 10_000, body: 2_000, live: 0 },
  getIssues: { background: 10_000, body: 2_000, live: 0 },
  getFlow: { background: 10_000, body: 2_000, live: 1_000 },
  getDiscover: { background: 10_000, body: 2_000, live: 1_000 },
  getGoalDrafts: { background: 10_000, body: 2_000, live: 0 },
  listRecords: { background: 10_000, body: 10_000, live: 0 },
  getSkills: { background: 10_000, body: 10_000, live: 0 },
  getAgents: { background: 60_000, body: 5_000, live: 1_000 },
  getProviders: { background: 60_000, body: 60_000, live: 0 },
  getMcpTools: { background: 0, body: 60_000, live: 0 },
  getResources: { background: 0, body: 30_000, live: 0 },
  getInstalledSkills: { background: 0, body: 30_000, live: 0 },
  getComplexity: { background: 0, body: 30_000, live: 0 },
  getIssuesRun: { background: 0, body: 0, live: 1_000 },
  getInquiry: { background: 0, body: 1_000, live: 0 },
};

/**
 * GET operations a surface reads once as it opens or the page connects, never
 * on a timer: the project path, one draft's text, one agent's snapshot, one
 * agent's prompt. Listing them here is what makes the cadence table complete.
 */
export const ONE_SHOT_READS: Readonly<Record<string, true>> = {
  getProject: true,
  getGoalDraft: true,
  getAgent: true,
  getAgentPrompt: true,
};

/** The table's cadence for one operation shown by one scope; 0 means never. */
export function cadenceFor(type: string, scope: PollScope): number {
  const row = RESOURCE_CADENCE_MS[type];
  return row === undefined ? 0 : row[scope];
}
