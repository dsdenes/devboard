import { dirname, join, resolve } from "node:path";
import { createApp } from "./app";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const adrDir = resolve(process.env.ADRS_DIR ?? "/repo/adrs");
const repoDir = resolve(process.env.REPO_DIR ?? dirname(adrDir));
const goalFile = process.env.GOAL_FILE
  ? resolve(process.env.GOAL_FILE)
  : join(repoDir, "GOAL.md");
const staticDir = process.env.STATIC_DIR ?? join(import.meta.dir, "..", "dist");
const agentCommand = process.env.AGENT_COMMAND ?? "omp acp";

const server = createApp({ adrDir, repoDir, goalFile, agentCommand, staticDir, hostname, port });

console.log(`ADR interface listening on http://${hostname}:${server.port}`);
