/**
 * The browser endpoints the client and the server share. The client posts and
 * reads them, the server routes them, and the Vite dev proxy forwards them, so
 * one name each keeps a dev page from answering its own 404 when a path moves.
 */
export const REPORTS_ENDPOINT = "/reports";
export const GOAL_PROPOSALS_ENDPOINT = "/goal-proposals";
/** The client reads `/ready` to learn which process answered it. */
export const READY_ENDPOINT = "/ready";
/** The runs view reads `/agent-runs` beside the REST route table. */
export const AGENT_RUNS_ENDPOINT = "/agent-runs";

/**
 * Every endpoint a dev page must reach through the backend. The client calls
 * each of them directly, so the proxy forwards each one and a dev page reads
 * the dashboard's answer instead of the dev server's.
 */
export const BACKEND_ENDPOINTS: readonly string[] = [
  REPORTS_ENDPOINT,
  GOAL_PROPOSALS_ENDPOINT,
  READY_ENDPOINT,
  AGENT_RUNS_ENDPOINT,
];
