import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  checksumName,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  downloadRelease,
  exec,
  installHarnessTarball,
  installRelease,
  isReleaseThrottled,
  isReleaseUnreachable,
  latestRelease,
  parseReleaseDescription,
  ReleaseError,
  ReleaseFeedError,
  tarballName,
  type ReleaseInfo,
  type ReleaseSource,
} from "./release";

/** Release transport behaviour that needs a real npm install. */

const testRoot = join(import.meta.dir, "..", ".tmp", "release-tests");
const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) rmSync(directory, { recursive: true, force: true });
});

function workspace(name: string): string {
  const directory = join(testRoot, `${name}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  cleanup.push(directory);
  return directory;
}

function harnessTarball(directory: string): string {
  const packageDirectory = join(directory, "package");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "9.9.9" })}\n`,
  );
  const tarball = join(directory, "devboard-9.9.9.tgz");
  const packed = Bun.spawnSync({
    cmd: ["tar", "-czf", tarball, "-C", directory, "package"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode).toBe(0);
  return tarball;
}

describe("isReleaseUnreachable", () => {
  test("treats a missing release command as an unreachable feed", async () => {
    const missing = `devboard-missing-gh-${crypto.randomUUID()}`;
    const error = await exec(missing, []).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect(isReleaseUnreachable(error)).toBe(true);
  });
});

describe("isReleaseThrottled", () => {
  test("treats a GitHub request allowance as a throttle", () => {
    const error = new ReleaseError(
      "gh api releases/latest failed: gh: API rate limit exceeded for user ID 123850.",
    );
    expect(isReleaseThrottled(error)).toBe(true);
  });

  test("treats an npm 429 as a throttle", () => {
    const error = new ReleaseError(
      "npm could not resolve @dsdenes/devboard: npm error 429 Too Many Requests - GET " +
        "https://registry.npmjs.org/@dsdenes%2fdevboard",
    );
    expect(isReleaseThrottled(error)).toBe(true);
  });

  test("treats a Gitea 429 as a throttle", () => {
    const error = new ReleaseError(
      'the release feed answered HTTP 429: {"message":"Too many requests"}',
    );
    expect(isReleaseThrottled(error)).toBe(true);
  });

  test("does not treat an authentication failure or a version as a throttle", () => {
    expect(isReleaseThrottled(new ReleaseError("gh: HTTP 401: Bad credentials"))).toBe(false);
    expect(isReleaseThrottled(new ReleaseError("npm returned an unreadable version: 0.1.429"))).toBe(
      false,
    );
  });
});

describe("parseReleaseDescription", () => {
  function caught(run: () => unknown): Error {
    try {
      run();
    } catch (reason) {
      return reason as Error;
    }
    throw new Error("expected the release description to be rejected");
  }

  test("reads the release object gh prints", () => {
    const info = parseReleaseDescription(
      JSON.stringify({
        tag_name: "v0.1.12",
        assets: [
          { name: "devboard-0.1.12.tgz", id: 7, size: 9 },
          { name: "devboard-0.1.12.tgz.sha256" },
          { id: 8 },
        ],
      }),
    );
    expect(info).toEqual({
      version: "0.1.12",
      tag: "v0.1.12",
      assets: [
        { name: "devboard-0.1.12.tgz", id: 7, size: 9 },
        { name: "devboard-0.1.12.tgz.sha256" },
      ],
    });
  });

  test("names a non-JSON body as unreadable feed data", () => {
    const body =
      '{"tag":"v1.0.0","publishedAt":"2026-10-20T00:00:00Z","draft":false}\n' +
      '{"tag":"v1.1.0","publishedAt":"2026-10-21T00:00:00Z","draft":false}\n';
    const error = caught(() => parseReleaseDescription(body));
    expect(error).toBeInstanceOf(ReleaseFeedError);
    expect(error.message).toBe(
      "the release feed returned an unreadable description: " +
        '{"tag":"v1.0.0","publishedAt":"2026-10-20T00:00:00Z","draft":false}',
    );
  });

  test("names a JSON body that is not a release object as unreadable feed data", () => {
    for (const body of ["null", "[]", '"v1.0.0"']) {
      expect(() => parseReleaseDescription(body)).toThrow(ReleaseFeedError);
    }
  });

  test("rejects a release object without a tag as a release error", () => {
    const error = caught(() => parseReleaseDescription('{"assets":[]}'));
    expect(error).toBeInstanceOf(ReleaseError);
    expect(error).not.toBeInstanceOf(ReleaseFeedError);
    expect(error.message).toBe("the latest release has no tag");
  });
});

describe("installHarnessTarball", () => {
  test("installs with an explicit cwd after the process cwd is deleted", async () => {
    const root = workspace("deleted-cwd");
    const tarball = harnessTarball(root);
    const prefix = join(root, "prefix");
    mkdirSync(prefix, { recursive: true });
    const script = join(root, "install.ts");
    writeFileSync(
      script,
      `import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installHarnessTarball } from ${JSON.stringify(join(import.meta.dir, "release.ts"))};

const gone = join(import.meta.dir, "gone");
mkdirSync(gone, { recursive: true });
process.chdir(gone);
rmSync(gone, { recursive: true, force: true });
const installed = await installHarnessTarball({
  prefix: process.argv[2] ?? "",
  tarball: process.argv[3] ?? "",
  version: "9.9.9",
});
console.log(installed);
`,
    );

    const child = Bun.spawnSync({
      cmd: [process.execPath, script, prefix, tarball],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(
      child.exitCode,
      `${child.stderr.toString()}${child.stdout.toString()}`,
    ).toBe(0);
    const target = join(prefix, "node_modules", "@dsdenes", "devboard");
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version).toBe("9.9.9");
  }, 60_000);
});

interface StallServer {
  port: number;
  close: () => void;
}

function giteaSource(server: StallServer): ReleaseSource {
  return { kind: "gitea", baseUrl: `http://127.0.0.1:${server.port}`, repo: "acme/fixture" };
}

function stalledRelease(version: string, baseUrl: string): ReleaseInfo {
  return {
    version,
    tag: `v${version}`,
    assets: [
      {
        name: tarballName(version),
        id: 11,
        browser_download_url: `${baseUrl}/stall/${tarballName(version)}`,
      },
      {
        name: checksumName(version),
        id: 12,
        browser_download_url: `${baseUrl}/stall/${checksumName(version)}`,
      },
    ],
  };
}

/** A TCP server that accepts and never answers; aborting the fetch ends it. */
async function stallingServer(): Promise<StallServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

describe("release download deadline", () => {
  test("uses the same ten minute budget as an install", () => {
    expect(DEFAULT_DOWNLOAD_TIMEOUT_MS).toBe(10 * 60_000);
  });

  test("aborts a stalled download at the deadline and removes the partial asset", async () => {
    const root = workspace("stalled-download");
    const destination = join(root, "download");
    const server = await stallingServer();
    try {
      const started = Date.now();
      const source = giteaSource(server);
      const error = await downloadRelease(
        source,
        stalledRelease("1.2.3", source.kind === "gitea" ? source.baseUrl : ""),
        destination,
        { timeoutMs: 500 },
      ).catch((reason: unknown) => reason);
      const elapsed = Date.now() - started;
      expect(error).toBeInstanceOf(ReleaseError);
      expect((error as Error).message).toContain("timed out after 500 ms");
      expect(elapsed).toBeLessThan(10_000);
      expect(existsSync(join(destination, tarballName("1.2.3")))).toBe(false);
    } finally {
      server.close();
    }
  }, 20_000);

  test("installRelease rejects at the deadline and leaves no staged download", async () => {
    const root = workspace("stalled-install");
    const prefix = join(root, "prefix");
    mkdirSync(prefix, { recursive: true });
    const stateDir = join(root, "state");
    const server = await stallingServer();
    try {
      const started = Date.now();
      const source = giteaSource(server);
      const error = await installRelease({
        source,
        release: stalledRelease("1.2.3", source.kind === "gitea" ? source.baseUrl : ""),
        prefix,
        stateDir,
        downloadTimeoutMs: 500,
      }).catch((reason: unknown) => reason);
      const elapsed = Date.now() - started;
      expect(error).toBeInstanceOf(ReleaseError);
      expect((error as Error).message).toContain("timed out after 500 ms");
      expect(elapsed).toBeLessThan(10_000);
      expect(readdirSync(join(stateDir, "updates"))).toEqual([]);
    } finally {
      server.close();
    }
  }, 20_000);
});

describe("npm fallback", () => {
  test("uses the configured Gitea release when npm cannot resolve a version", async () => {
    const root = workspace("npm-fallback");
    const npm = join(root, "failing-npm");
    writeFileSync(npm, "#!/bin/sh\necho 'simulated npm outage' >&2\nexit 1\n");
    chmodSync(npm, 0o755);
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/releases/latest")) {
          return Response.json({ tag_name: "v0.1.42", assets: [] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const release = await latestRelease({
        kind: "npm",
        env: { DEVBOARD_NPM: npm },
        fallback: {
          kind: "gitea",
          baseUrl: `http://127.0.0.1:${server.port}`,
          repo: "acme/fixture",
        },
      });
      expect(release.version).toBe("0.1.42");
    } finally {
      server.stop(true);
    }
  });

  test("names npm when it fails and no fallback is configured", async () => {
    const root = workspace("npm-no-fallback");
    const npm = join(root, "failing-npm");
    writeFileSync(npm, "#!/bin/sh\necho 'simulated npm outage' >&2\nexit 1\n");
    chmodSync(npm, 0o755);
    const error = await latestRelease({ kind: "npm", env: { DEVBOARD_NPM: npm } }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ReleaseError);
    expect((error as Error).message).toContain("npm could not resolve");
  });
});
