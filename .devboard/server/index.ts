import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import { hostHarnessDir } from "./version";

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8080);
const adrDir = resolve(process.env.ADRS_DIR ?? "/repo/adrs");
const repoDir = resolve(process.env.REPO_DIR ?? dirname(adrDir));
const goalFile = process.env.GOAL_FILE
  ? resolve(process.env.GOAL_FILE)
  : join(repoDir, "GOAL.md");
const staticDir = process.env.STATIC_DIR ?? join(import.meta.dir, "..", "dist");
const agentCommand = process.env.AGENT_COMMAND ?? "omp acp";

function isAddressInUse(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "EADDRINUSE") return true;
  }
  return /EADDRINUSE|address already in use|port .* in use/i.test(String(error));
}

/**
 * Replaces this process with the harness the host now points at. Stopping the
 * listener first frees the port; the replacement retries the bind while the
 * old process finishes exiting. It reads the same repository and settings.
 */
function restart(server: Server<unknown>) {
  server.stop(true);
  const harness = hostHarnessDir(repoDir);
  // A new session protects the replacement when the launcher itself was
  // started inside a process group that is being shut down.
  const setsid = process.platform === "win32" ? null : Bun.which("setsid");
  const child = Bun.spawn({
    cmd: [
      ...(setsid === null ? [] : [setsid]),
      process.execPath,
      join(harness, "server", "index.ts"),
    ],
    cwd: harness,
    env: {
      ...process.env,
      HOST: hostname,
      PORT: String(port),
      ADRS_DIR: adrDir,
      REPO_DIR: repoDir,
      GOAL_FILE: goalFile,
      STATIC_DIR: join(harness, "dist"),
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  process.exit(0);
}

let server: Server<unknown> | undefined;
for (let attempt = 0; ; attempt += 1) {
  try {
    server = createApp({
      adrDir,
      repoDir,
      goalFile,
      agentCommand,
      staticDir,
      hostname,
      port,
      restart: () => {
        if (server !== undefined) restart(server);
      },
    });
    break;
  } catch (error) {
    // A replacement process can reach the bind before this one has exited.
    if (attempt >= 50 || !isAddressInUse(error)) throw error;
    await Bun.sleep(100);
  }
}

console.log(`ADR interface listening on http://${hostname}:${server.port}`);
