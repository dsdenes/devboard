import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { relaunch, relaunchConfirmed, type Listener, type RelaunchSettings } from "./relaunch";

const harnessRoot = resolve(import.meta.dir, "..");

const settings: RelaunchSettings = {
  hostname: "127.0.0.1",
  port: 8080,
  adrDir: "/host/adrs",
  repoDir: "/host",
  goalFile: "/host/GOAL.md",
  stateDir: "/host/.devboard/.tmp",
};

function listener(events: string[]): Listener {
  return {
    stop(closeActiveConnections) {
      events.push(`stop:${String(closeActiveConnections)}`);
    },
  };
}

describe("relaunch", () => {
  test("leaves the listener serving when the replacement cannot spawn", () => {
    const events: string[] = [];
    let exits = 0;

    expect(() =>
      relaunch(listener(events), settings, {
        stop: (server) => server.stop(true),
        exit: () => {
          exits += 1;
        },
        harnessDir: () => "/host/.devboard",
        exists: () => true,
        spawn: () => {
          events.push("spawn");
          throw new Error("spawn failed");
        },
      }),
    ).toThrow("spawn failed");
    expect(events).toEqual(["spawn"]);
    expect(exits).toBe(0);
  });

  test("does not stop the listener when the replacement entry is missing", () => {
    const events: string[] = [];
    let spawned = 0;

    expect(() =>
      relaunch(listener(events), settings, {
        stop: (server) => server.stop(true),
        exit: () => {},
        harnessDir: () => "/host/.devboard",
        exists: (path) => {
          expect(path).toBe(join("/host/.devboard", "server", "index.ts"));
          return false;
        },
        spawn: () => {
          spawned += 1;
          return { unref: () => {} };
        },
      }),
    ).toThrow("The replacement server is missing at /host/.devboard/server/index.ts.");
    expect(spawned).toBe(0);
    expect(events).toEqual([]);
  });

  test("tells connected pages after the replacement exists and before the stop", () => {
    const events: string[] = [];

    relaunch(listener(events), settings, {
      stop: (server) => server.stop(true),
      exit: () => {},
      beforeStop: () => events.push("beforeStop"),
      harnessDir: () => "/host/.devboard",
      exists: () => true,
      spawn: () => {
        events.push("spawn");
        return { unref: () => events.push("unref") };
      },
    });

    expect(events).toEqual(["spawn", "unref", "beforeStop", "stop:true"]);
  });

  test("stops the listener only after the replacement process exists", () => {
    const events: string[] = [];
    let options:
      | { cmd: string[]; cwd: string; env: Record<string, string | undefined> }
      | undefined;

    relaunch(listener(events), settings, {
      stop: (server) => server.stop(true),
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      harnessDir: () => "/host/.devboard",
      exists: () => true,
      spawn: (spawned) => {
        options = spawned;
        events.push("spawn");
        return {
          unref: () => {
            events.push("unref");
          },
        };
      },
    });

    expect(events).toEqual(["spawn", "unref", "stop:true", "exit:0"]);
    expect(options?.cwd).toBe("/host");
    expect(options?.cmd.at(-1)).toBe(join("/host/.devboard", "server", "index.ts"));
    expect(options?.env).toMatchObject({
      HOST: "127.0.0.1",
      PORT: "8080",
      ADRS_DIR: "/host/adrs",
      REPO_DIR: "/host",
      GOAL_FILE: "/host/GOAL.md",
      STATIC_DIR: join("/host/.devboard", "dist"),
      STATE_DIR: "/host/.devboard/.tmp",
    });
  });
});

describe("relaunchConfirmed", () => {
  function markerPath(): string {
    return join(harnessRoot, ".tmp", `ready-${randomUUID()}.json`);
  }

  test("waits for the replacement marker before stopping the listener", async () => {
    const events: string[] = [];
    const readyFile = markerPath();
    await mkdir(join(harnessRoot, ".tmp"), { recursive: true });

    await relaunchConfirmed(
      listener(events),
      settings,
      {
        stop: (server) => server.stop(true),
        exit: (code) => events.push(`exit:${code}`),
        beforeStop: () => events.push("beforeStop"),
        harnessDir: () => "/host/.devboard",
        exists: () => true,
        spawn: (options) => {
          expect(options.env.DEVBOARD_REPLACEMENT_READY_FILE).toBe(readyFile);
          events.push("spawn");
          void writeFile(options.env.DEVBOARD_REPLACEMENT_READY_FILE ?? "", "ready\n");
          return {
            pid: 4242,
            unref: () => events.push("unref"),
            kill: () => events.push("kill"),
          };
        },
      },
      { readyFile, timeoutMs: 500, pollMs: 5, alive: () => true },
    );

    expect(events).toEqual(["spawn", "unref", "beforeStop", "stop:true", "exit:0"]);
    expect(existsSync(readyFile)).toBe(false);
  });

  test("leaves the listener serving when the replacement never becomes ready", async () => {
    const events: string[] = [];
    const readyFile = markerPath();
    await mkdir(join(harnessRoot, ".tmp"), { recursive: true });

    await expect(
      relaunchConfirmed(
        listener(events),
        settings,
        {
          stop: (server) => server.stop(true),
          exit: () => events.push("exit"),
          beforeStop: () => events.push("beforeStop"),
          harnessDir: () => "/host/.devboard",
          exists: () => true,
          spawn: () => {
            events.push("spawn");
            return {
              pid: 4343,
              unref: () => events.push("unref"),
              kill: () => events.push("kill"),
            };
          },
        },
        {
          readyFile,
          timeoutMs: 5_000,
          pollMs: 5,
          alive: () => false,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("did not become ready");
    expect(events).toEqual(["spawn", "unref", "kill"]);
  });

  test("a stubbed replacement failure keeps the listener serving", async () => {
    const stub = markerPath();
    await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
    await writeFile(stub, "fail\n");
    const previous = process.env.DEVBOARD_REPLACEMENT_STUB;
    process.env.DEVBOARD_REPLACEMENT_STUB = stub;
    const events: string[] = [];
    try {
      await expect(
        relaunchConfirmed(
          listener(events),
          settings,
          {
            stop: (server) => server.stop(true),
            exit: () => events.push("exit"),
            harnessDir: () => "/host/.devboard",
            exists: () => true,
          },
          { readyFile: markerPath(), timeoutMs: 100, pollMs: 5 },
        ),
      ).rejects.toThrow("stubbed replacement failure");
    } finally {
      if (previous === undefined) delete process.env.DEVBOARD_REPLACEMENT_STUB;
      else process.env.DEVBOARD_REPLACEMENT_STUB = previous;
      await rm(stub, { force: true });
    }
    expect(events).toEqual([]);
  });
});
