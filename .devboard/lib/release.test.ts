import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { basename, join } from "node:path";
import {
  checksumName,
  compareReleaseVersions,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  downloadRelease,
  exec,
  highestReleaseVersion,
  installHarnessTarball,
  installRelease,
  isReleaseRateLimited,
  isReleaseUnreachable,
  latestRelease,
  lowestReleaseVersion,
  npmInstallError,
  parseReleaseDescription,
  publishTagFor,
  ReleaseError,
  ReleaseFeedError,
  ReleaseNotServedError,
  SIDE_RELEASE_TAG,
  tarballName,
  type CommandResult,
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

/** A tarball plus the checksum file a directory release must hold. */
function releaseTarball(directory: string): string {
  const tarball = harnessTarball(directory);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`);
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

describe("isReleaseRateLimited", () => {
  test("recognizes a primary or secondary GitHub quota message", () => {
    for (const detail of [
      "gh: API rate limit exceeded for user ID 123850. If you reach out to GitHub Support " +
        "for help, please include the request ID C078:C6E1C:11323A2:18BF786:6AE201F6.",
      "You have exceeded a secondary rate limit. Please wait a few minutes.",
      "gh: rate-limited request rejected",
    ]) {
      expect(isReleaseRateLimited(new Error(`gh api releases/latest failed: ${detail}`))).toBe(
        true,
      );
    }
  });

  test("recognizes a registry 429 from npm or Gitea", () => {
    for (const detail of [
      "npm error code E429",
      "npm error 429 Too Many Requests - GET https://registry.npmjs.org/@dsdenes%2fdevboard",
      "HTTP 429: Too Many Requests",
      "the feed answered 429 Too Many Requests",
    ]) {
      expect(isReleaseRateLimited(new Error(detail))).toBe(true);
    }
  });

  test("does not treat an authentication failure or an outage as a rate limit", () => {
    expect(
      isReleaseRateLimited(new Error("gh api releases/latest failed: HTTP 401: Bad credentials")),
    ).toBe(false);
    expect(
      isReleaseRateLimited(
        new Error(
          'gh api releases/latest failed: Get "https://api.github.com": dial tcp: i/o timeout',
        ),
      ),
    ).toBe(false);
  });
});

describe("npmInstallError", () => {
  const version = "0.1.592";
  const tarball = `https://registry.npmjs.org/@dsdenes/devboard/-/${tarballName(version)}`;

  function failed(stderr: string): CommandResult {
    return { code: 1, stdout: "", stderr, killed: false };
  }

  test("treats the package's own unpropagated tarball as context", () => {
    const error = npmInstallError(
      failed(
        [
          "npm error code E404",
          `npm error 404 Not Found - GET ${tarball}`,
          "npm error 404",
          `npm error 404  The requested resource '@dsdenes/devboard@${tarball}' could not be found.`,
        ].join("\n"),
      ),
      version,
    );
    expect(error).toBeInstanceOf(ReleaseNotServedError);
    expect(error.message).toBe(
      `npm does not serve the advertised @dsdenes/devboard@${version} artifact yet: ${tarball}`,
    );
  });

  test("treats a gone artifact reported by an older npm as context", () => {
    const error = npmInstallError(
      failed(`npm ERR! code E410\nnpm ERR! 410 Gone - GET ${tarball}`),
      version,
    );
    expect(error).toBeInstanceOf(ReleaseNotServedError);
  });

  test("keeps a missing dependency tarball a release defect", () => {
    const error = npmInstallError(
      failed(
        "npm error code E404\n" +
          "npm error 404 Not Found - GET https://registry.npmjs.org/mermaid/-/mermaid-11.12.0.tgz",
      ),
      version,
    );
    expect(error).not.toBeInstanceOf(ReleaseNotServedError);
    expect(error.message).toBe("npm install failed: npm error code E404");
  });

  test("keeps another version's tarball a release defect", () => {
    const other = `https://registry.npmjs.org/@dsdenes/devboard/-/${tarballName("0.1.597")}`;
    const error = npmInstallError(
      failed(`npm error code E404\nnpm error 404 Not Found - GET ${other}`),
      version,
    );
    expect(error).not.toBeInstanceOf(ReleaseNotServedError);
  });

  test("keeps a 404 without a tarball URL and any other failure a release defect", () => {
    for (const stderr of [
      "npm error code E404",
      "npm error code EINTEGRITY",
      "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@dsdenes%2fdevboard",
    ]) {
      const error = npmInstallError(failed(stderr), version);
      expect(error).not.toBeInstanceOf(ReleaseNotServedError);
      expect(error).toBeInstanceOf(ReleaseError);
    }
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
    expect(child.stdout.toString().trim()).toBe("9.9.9");
    const target = join(prefix, "node_modules", "@dsdenes", "devboard");
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version).toBe("9.9.9");
  }, 60_000);
});

describe("installRelease", () => {
  test("returns a directory release's version and records it in the prefix", async () => {
    const root = workspace("directory-install");
    const tarball = releaseTarball(root);
    const prefix = join(root, "prefix");
    mkdirSync(prefix, { recursive: true });
    const stateDir = join(root, "state");
    const installed = await installRelease({
      source: { kind: "dir", directory: root },
      release: {
        version: "9.9.9",
        tag: "v9.9.9",
        assets: [{ name: tarballName("9.9.9") }, { name: checksumName("9.9.9") }],
      },
      prefix,
      stateDir,
    });
    expect(installed).toBe("9.9.9");
    expect(installed).not.toContain(root);
    expect(installed).not.toContain(tarball);
    const manifest: unknown = JSON.parse(readFileSync(join(prefix, "package.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) {
      throw new Error("prefix package.json has no dependencies");
    }
    expect(manifest.dependencies).toEqual({ "@dsdenes/devboard": "9.9.9" });
    expect(
      JSON.parse(
        readFileSync(
          join(prefix, "node_modules", "@dsdenes", "devboard", "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("9.9.9");
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
    const requested: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requested.push(url.pathname);
        if (url.pathname === "/api/v1/repos/acme/fixture/releases/latest") {
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
      expect(requested).toEqual(["/api/v1/repos/acme/fixture/releases/latest"]);
    } finally {
      server.stop(true);
    }
  });

  test("names an unreadable fallback body as feed context", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('{"tag":"v1.0.0"}\n{"tag":"v1.1.0"}\n');
      },
    });
    try {
      const error = await latestRelease({
        kind: "gitea",
        baseUrl: `http://127.0.0.1:${server.port}`,
        repo: "acme/fixture",
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ReleaseFeedError);
      expect((error as Error).message).toContain(
        "the release feed returned an unreadable description",
      );
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

describe("release ordering", () => {
  test("orders dotted versions numerically rather than as text", () => {
    expect(compareReleaseVersions("0.1.9", "0.1.10")).toBeLessThan(0);
    expect(compareReleaseVersions("0.1.713", "0.1.713")).toBe(0);
    expect(compareReleaseVersions("0.1.714", "0.1.713")).toBeGreaterThan(0);
    expect(compareReleaseVersions("0.1", "0.1.7")).toBeUndefined();
    expect(compareReleaseVersions("0.1.x", "0.1.7")).toBeUndefined();
  });

  test("picks the highest release version and ignores malformed tags", () => {
    expect(highestReleaseVersion(["0.1.704", "0.1.713", "0.1.9"])).toBe("0.1.713");
    expect(highestReleaseVersion(["v0.1.713", "0.1.6", "", "0.1"])).toBe("0.1.6");
    expect(highestReleaseVersion([])).toBeUndefined();
  });

  test("picks the earliest release that contains a change", () => {
    expect(lowestReleaseVersion(["1.0.4", "1.0.1", "1.0.10", "1.0.2"])).toBe("1.0.1");
    expect(lowestReleaseVersion(["v1.0.1", "1.0", ""])).toBeUndefined();
    expect(lowestReleaseVersion([])).toBeUndefined();
  });

  test("publishes a lower version under the side tag instead of moving latest back", () => {
    expect(publishTagFor("0.1.713", undefined)).toBe("latest");
    expect(publishTagFor("0.1.713", "0.1.704")).toBe("latest");
    expect(publishTagFor("0.1.713", "0.1.713")).toBe(SIDE_RELEASE_TAG);
    expect(publishTagFor("0.1.707", "0.1.713")).toBe(SIDE_RELEASE_TAG);
  });

  test("refuses to order a release against an unreadable newest version", () => {
    expect(() => publishTagFor("0.1.713", "0.1.bad")).toThrow(ReleaseError);
  });
});
