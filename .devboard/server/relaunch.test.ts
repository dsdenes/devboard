import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { relaunch, type Listener, type RelaunchSettings } from "./relaunch";

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
