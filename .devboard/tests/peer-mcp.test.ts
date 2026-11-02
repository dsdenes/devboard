import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcpConnection } from "../server/acp";
import { sessionMcpServers } from "../server/peer-mcp";
import { createdDirectories, temporaryDirectory } from "./fixtures/scout-helpers";

afterAll(async () => {
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A minimal ACP peer that records the `session/new` parameters it receives. */
const STUB = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const sessionId = "stub-session";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (typeof message.method !== "string" || message.id === undefined) continue;
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      appendFileSync(process.env.MCP_STUB_LOG, JSON.stringify(message.params) + "\\n");
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}
`;

/** The generated agent directory one peer starts with. */
async function agentDirectory(registration: unknown): Promise<string> {
  const directory = await temporaryDirectory("peer-mcp");
  const agentDir = join(directory, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(registration));
  return agentDir;
}

const DEVBOARD = {
  type: "stdio",
  command: "sh",
  args: ["-c", 'exec bun "$PI_CODING_AGENT_DIR/devboard-mcp.ts"'],
};

describe("peer MCP registration", () => {
  test("translates the generated registration into the session shape", async () => {
    const agentDir = await agentDirectory({
      mcpServers: {
        devboard: DEVBOARD,
        instrumented: { type: "stdio", command: "bun", args: ["server.ts"], env: { MARK: "1" } },
        disabled: { ...DEVBOARD, enabled: false },
        remote: { type: "http", url: "https://example.invalid/mcp" },
      },
    });
    expect(sessionMcpServers({ PI_CODING_AGENT_DIR: agentDir })).toEqual([
      {
        name: "devboard",
        command: "sh",
        args: ["-c", 'exec bun "$PI_CODING_AGENT_DIR/devboard-mcp.ts"'],
        env: [],
      },
      {
        name: "instrumented",
        command: "bun",
        args: ["server.ts"],
        env: [{ name: "MARK", value: "1" }],
      },
    ]);
  });

  test("a peer without a generated directory registers no server", async () => {
    expect(sessionMcpServers({})).toEqual([]);
    expect(sessionMcpServers(undefined)).toEqual([]);
    expect(sessionMcpServers({ PI_CODING_AGENT_DIR: "/nonexistent/agent" })).toEqual([]);
  });

  test("the session request carries the peer's generated registration", async () => {
    const agentDir = await agentDirectory({ mcpServers: { devboard: DEVBOARD } });
    const log = join(agentDir, "session-new.log");
    const script = join(agentDir, "stub-acp.ts");
    await writeFile(script, STUB);

    const connection = new AcpConnection({
      command: `${process.execPath} ${script}`,
      cwd: agentDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MCP_STUB_LOG: log },
      onActivity: () => undefined,
      onQuestion: () => undefined,
    });
    try {
      await connection.run("survey");
    } finally {
      connection.close();
    }

    const params = JSON.parse(readFileSync(log, "utf8").trim());
    expect(params.mcpServers).toEqual([
      {
        name: "devboard",
        command: "sh",
        args: ["-c", 'exec bun "$PI_CODING_AGENT_DIR/devboard-mcp.ts"'],
        env: [],
      },
    ]);
  });
});
