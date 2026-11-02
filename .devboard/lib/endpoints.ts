/**
 * The browser endpoints that create state. The client posts to them, the
 * server routes them, and the Vite dev proxy forwards them, so one name each
 * keeps a dev page from answering its own 404 when a path moves.
 */
export const FEEDBACK_ENDPOINT = "/feedback";
export const GOAL_PROPOSALS_ENDPOINT = "/goal-proposals";

/** Every endpoint a dev page must reach through the backend. */
export const MUTATION_ENDPOINTS: readonly string[] = [
  FEEDBACK_ENDPOINT,
  GOAL_PROPOSALS_ENDPOINT,
];
