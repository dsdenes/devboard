import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  discoverLocalGitea,
  isGiteaVersionDocument,
  listeningPortsFrom,
  type LocalFetch,
} from "../lib/local-gitea";
import { sourceCheckoutGiteaUrl } from "../server/local-gitea";

/**
 * A dashboard started from the canonical `.devboard` checkout discovers the
 * local Gitea instance from the loopback listeners when no HTTP origin is
 * configured. Installed hosts and non-local origins never probe.
 */

const testRoot = join(import.meta.dir, "..", ".tmp", "local-gitea-tests");
const created: string[] = [];

afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function repository(remote: string): string {
  const directory = join(testRoot, `repo-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  created.push(directory);
  const git = (args: string[]) => {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", directory, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git(["init", "-q"]);
  git(["remote", "add", "origin", remote]);
  return directory;
}

/** The port in a probe URL; the default HTTP port normalizes to an empty string. */
function portOf(input: string): number {
  const url = new URL(input);
  return url.port === "" ? (url.protocol === "http:" ? 80 : 443) : Number(url.port);
}

/** A Gitea reply on one port and refusals everywhere else. */
function giteaOn(port: number, calls?: { count: number }): LocalFetch {
  return async (input) => {
    if (calls !== undefined) calls.count += 1;
    return portOf(input) === port
      ? Response.json({ version: "28.2.0" })
      : new Response("Not Found", { status: 404 });
  };
}

describe("loopback listener enumeration", () => {
  test("reads listening ports from a procfs table", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid",
      "   0: 0100007F:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000",
      "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000",
      "   2: 0100007F:9C40 0100007F:0BB9 01 00000000:00000000 00:00000000 00000000  1000",
      "   3: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 0",
    ].join("\n");
    expect(listeningPortsFrom(table)).toEqual([80, 3001, 8080]);
  });

  test("ignores malformed rows", () => {
    expect(listeningPortsFrom("garbage\n0: 0100007F 00000000:0000 0A\n")).toEqual([]);
  });
});

describe("Gitea identity", () => {
  test("accepts only a non-empty version document", () => {
    expect(isGiteaVersionDocument({ version: "28.2.0" })).toBe(true);
    expect(isGiteaVersionDocument({ version: "" })).toBe(false);
    expect(isGiteaVersionDocument({ version: 28 })).toBe(false);
    expect(isGiteaVersionDocument({ message: "Not Found" })).toBe(false);
    expect(isGiteaVersionDocument(null)).toBe(false);
    expect(isGiteaVersionDocument("28.2.0")).toBe(false);
  });
});

describe("local discovery", () => {
  test("takes the lowest loopback port that answers as Gitea", async () => {
    const fake: LocalFetch = async (input) => {
      const port = portOf(input);
      if (port === 8080) return new Response("Not Found", { status: 404 });
      if (port === 80) {
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      }
      return Response.json({ version: "28.2.0" });
    };
    expect(
      await discoverLocalGitea({ ports: [8080, 4000, 3001, 80], fetchImpl: fake }),
    ).toBe("http://127.0.0.1:3001");
  });

  test("returns undefined when no listener answers as Gitea", async () => {
    expect(
      await discoverLocalGitea({
        ports: [3001, 8080],
        fetchImpl: async () => new Response("Not Found", { status: 404 }),
      }),
    ).toBeUndefined();
  });

  test("survives a refused connection", async () => {
    const fake: LocalFetch = async () => {
      throw new Error("connection refused");
    };
    expect(await discoverLocalGitea({ ports: [3001], fetchImpl: fake })).toBeUndefined();
  });
});

describe("source-checkout gate", () => {
  test("discovers for a local SSH Gitea origin", async () => {
    const repoDir = repository("ssh://git@localhost:2223/acme/fixture.git");
    const url = await sourceCheckoutGiteaUrl({
      repoDir,
      environment: {},
      sourceCheckout: true,
      ports: [8080, 3001],
      fetchImpl: giteaOn(3001),
    });
    expect(url).toBe("http://127.0.0.1:3001");
  });

  test("an explicit address always wins", async () => {
    const repoDir = repository("ssh://git@localhost:2223/acme/fixture.git");
    const calls = { count: 0 };
    const url = await sourceCheckoutGiteaUrl({
      repoDir,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      sourceCheckout: true,
      ports: [3001],
      fetchImpl: giteaOn(3001, calls),
    });
    expect(url).toBeUndefined();
    expect(calls.count).toBe(0);
  });

  test("an installed host never probes", async () => {
    const repoDir = repository("ssh://git@localhost:2223/acme/fixture.git");
    const calls = { count: 0 };
    const url = await sourceCheckoutGiteaUrl({
      repoDir,
      environment: {},
      sourceCheckout: false,
      ports: [3001],
      fetchImpl: giteaOn(3001, calls),
    });
    expect(url).toBeUndefined();
    expect(calls.count).toBe(0);
  });

  test("a non-Gitea origin never probes", async () => {
    const repoDir = repository("https://github.com/acme/fixture.git");
    const calls = { count: 0 };
    const url = await sourceCheckoutGiteaUrl({
      repoDir,
      environment: {},
      sourceCheckout: true,
      ports: [3001],
      fetchImpl: giteaOn(3001, calls),
    });
    expect(url).toBeUndefined();
    expect(calls.count).toBe(0);
  });

  test("an HTTP Gitea origin needs no discovery", async () => {
    const repoDir = repository("https://gitea.example/acme/fixture.git");
    const calls = { count: 0 };
    const url = await sourceCheckoutGiteaUrl({
      repoDir,
      environment: {},
      sourceCheckout: true,
      ports: [3001],
      fetchImpl: giteaOn(3001, calls),
    });
    expect(url).toBeUndefined();
    expect(calls.count).toBe(0);
  });

  test("a remote Gitea origin never reaches a local instance", async () => {
    const repoDir = repository("ssh://git@forge.example:2223/acme/fixture.git");
    const calls = { count: 0 };
    const url = await sourceCheckoutGiteaUrl({
      repoDir,
      environment: {},
      sourceCheckout: true,
      ports: [3001],
      fetchImpl: giteaOn(3001, calls),
    });
    expect(url).toBeUndefined();
    expect(calls.count).toBe(0);
  });
});
