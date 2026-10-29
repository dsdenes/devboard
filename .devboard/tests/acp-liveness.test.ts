import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcpConnection, type AcpActivity } from "../server/acp";
import { createdDirectories, temporaryDirectory } from "./fixtures/scout-helpers";

afterAll(async () => {
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A minimal ACP peer: it answers the handshake, then, on the prompt, reports a
 * tool call followed by a progress frame that carries no title.
 */
const STUB = `#!/usr/bin/env bun
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
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Reading the fixture" },
        },
      });
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: "halfway" } }],
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}
`;

/**
 * A minimal ACP peer that warns on stderr during its turn and prints its own
 * shutdown notice when the owner terminates it.
 */
const SIGTERM_STUB = `#!/usr/bin/env bun
import { writeSync } from "node:fs";
const sessionId = "stub-session";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

process.on("SIGTERM", () => {
  writeSync(2, "\\n[Stopped by SIGTERM]\\n[Recovery]\\n  acp:stub: omp --resume stub\\n");
  process.exit(0);
});

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
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      process.stderr.write("peer warning before close\\n");
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}
`;

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

describe("ACP session liveness", () => {
  test("a progress frame without an activity line still counts as liveness", async () => {
    const directory = await temporaryDirectory("acp-liveness");
    const script = join(directory, "stub-acp.ts");
    await writeFile(script, STUB);

    const activities: AcpActivity[] = [];
    let updates = 0;
    const connection = new AcpConnection({
      command: `${process.execPath} ${script}`,
      cwd: directory,
      onActivity: (activity) => activities.push(activity),
      onSessionUpdate: () => {
        updates += 1;
      },
      onQuestion: () => undefined,
    });
    try {
      await connection.run("survey");
      expect(activities).toEqual([{ text: "Reading the fixture", append: false }]);
      expect(updates).toBe(2);
    } finally {
      connection.close();
    }
  });

  test("stderr from a peer's intentional shutdown is not relayed", async () => {
    const directory = await temporaryDirectory("acp-stderr");
    const script = join(directory, "stub-acp.ts");
    await writeFile(script, SIGTERM_STUB);

    const chunks: string[] = [];
    const connection = new AcpConnection({
      command: `${process.execPath} ${script}`,
      cwd: directory,
      onActivity: () => undefined,
      onQuestion: () => undefined,
      onStderr: (text) => chunks.push(text),
    });
    try {
      await connection.run("work");
      await waitFor(
        () => chunks.join("").includes("peer warning before close"),
        "the peer's turn-time warning",
      );
      connection.close();
      await waitFor(() => connection.closed, "the peer to exit");
      // The stderr reader drains the pipe just after the process exits.
      await Bun.sleep(20);
    } finally {
      connection.close();
    }

    const reported = chunks.join("");
    expect(reported).toContain("peer warning before close");
    expect(reported).not.toContain("Stopped by SIGTERM");
  });
});
