import { afterAll, expect, test } from "bun:test";
import { lstatSync, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import { testProviderService } from "./fixtures/test-providers";

/**
 * This file owns its scratch root. Another test file's `afterAll` runs in a
 * different worker under `--parallel`, so a shared parent would let it delete
 * this file's fixtures while a test is mid-run.
 */
const TEST_ROOT = join(import.meta.dir, "..", ".test-tmp", "installed-skills");
const temporaryDirectories: string[] = [];
const servers: Server<unknown>[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await rm(TEST_ROOT, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TEST_ROOT, "installed-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

function skillSource(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: Guidance for ${name}.`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function managedSkillSource(name: string, family?: "prepare" | "discover"): string {
  return [
    "---",
    `name: ${name}`,
    `description: Guidance for ${name}.`,
    "metadata:",
    '  devboard-managed: "true"',
    ...(family === undefined ? [] : [`  devboard-family: ${family}`]),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function builtinSkillSource(name: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: Guidance for ${name}.`,
    "metadata:",
    '  devboard-builtin: "true"',
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function installedRow(
  name: string,
  enabled: boolean,
  content = skillSource(name),
  classification: { builtin?: boolean; deletable?: boolean } = {},
) {
  return {
    name,
    enabled,
    content,
    builtin: classification.builtin ?? false,
    deletable: classification.deletable ?? false,
  };
}

interface Fixture {
  root: string;
  skillsDir: string;
  settingsPath: string;
  url: string;
}

async function startFixture(
  names: string[] = ["alpha", "beta", "gamma"],
  options: { agentArguments?: string } = {},
): Promise<Fixture> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const skillsDir = join(root, ".omp", "skills");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Skills</title>");
  await writeFile(join(root, "GOAL.md"), "# Goal\n\nKeep the fixture buildable.\n");
  for (const name of names) {
    await mkdir(join(skillsDir, name), { recursive: true });
    await writeFile(join(skillsDir, name, "SKILL.md"), skillSource(name));
  }
  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
    ...(options.agentArguments === undefined
      ? {}
      : {
          agentCommand: [
            `bun ${join(import.meta.dir, "fixtures", "stub-agent.ts")}`,
            `--log=${join(root, "agent.log")}`,
            options.agentArguments,
          ].join(" "),
        }),
  });
  servers.push(server);
  return {
    root,
    skillsDir,
    settingsPath: join(root, ".omp", "settings.json"),
    url: `127.0.0.1:${server.port}`,
  };
}

interface TestClient {
  send(command: unknown): void;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const buffered: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }[] = [];

  socket.onopen = () => {
    resolve({
      send(command) {
        socket.send(JSON.stringify(command));
      },
      waitFor(predicate) {
        const index = buffered.findIndex(predicate);
        if (index >= 0) {
          const message = buffered.splice(index, 1)[0];
          if (message !== undefined) return Promise.resolve(message);
        }
        const { promise: waiting, resolve: settle } =
          Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: settle });
        return waiting;
      },
      close() {
        socket.close();
      },
    });
  };
  socket.onmessage = (event) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      waiter?.resolve(message);
      return;
    }
    buffered.push(message);
  };
  socket.onerror = () => reject(new Error("websocket failed"));
  return promise;
}

async function skillsState(url: string): Promise<Array<Record<string, unknown>>> {
  const client = await connect(url);
  try {
    client.send({ type: "getInstalledSkills" });
    const message = await client.waitFor((frame) => frame.type === "installedSkills");
    return message.skills as Array<Record<string, unknown>>;
  } finally {
    client.close();
  }
}

test("lists exactly the directories holding a SKILL.md, sorted, with symlinks and no extras", async () => {
  const fixture = await startFixture(["gamma", "alpha"]);
  await mkdir(join(fixture.skillsDir, "incomplete"), { recursive: true });
  await writeFile(join(fixture.skillsDir, "notes.txt"), "not a skill\n");
  await symlink("alpha", join(fixture.skillsDir, "linked"));

  expect(await skillsState(fixture.url)).toEqual([
    installedRow("alpha", true),
    installedRow("gamma", true),
    installedRow("linked", true, skillSource("alpha")),
  ]);
});

test("reads the project-level exclusion, including globs, and ignores names with no directory", async () => {
  const fixture = await startFixture(["alpha", "beta", "gamma"]);
  await mkdir(join(fixture.root, ".omp"), { recursive: true });
  await writeFile(
    fixture.settingsPath,
    `${JSON.stringify({ skills: { ignoredSkills: ["beta", "gam*", "not-installed"] } })}\n`,
  );

  expect(await skillsState(fixture.url)).toEqual([
    installedRow("alpha", true),
    installedRow("beta", false),
    installedRow("gamma", false),
  ]);
});

test("unchecking adds exactly one name and checking removes exactly that name", async () => {
  const fixture = await startFixture();
  await mkdir(join(fixture.root, ".omp"), { recursive: true });
  await writeFile(
    fixture.settingsPath,
    `${JSON.stringify({
      modelRoles: { commit: "provider/model" },
      skills: { includeSkills: ["kept"], ignoredSkills: ["existing"] },
      unrelated: { keep: true },
    })}\n`,
  );

  const client = await connect(fixture.url);
  try {
    client.send({ type: "setInstalledSkillEnabled", name: "beta", enabled: false });
    const unchecked = await client.waitFor((frame) => frame.type === "installedSkills");
    expect(unchecked.skills).toEqual([
      installedRow("alpha", true),
      installedRow("beta", false),
      installedRow("gamma", true),
    ]);

    const stored = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
    expect(stored).toEqual({
      modelRoles: { commit: "provider/model" },
      skills: { includeSkills: ["kept"], ignoredSkills: ["existing", "beta"] },
      unrelated: { keep: true },
    });

    client.send({ type: "setInstalledSkillEnabled", name: "beta", enabled: true });
    const resumed = await client.waitFor((frame) => frame.type === "installedSkills");
    expect(resumed.skills).toEqual([
      installedRow("alpha", true),
      installedRow("beta", true),
      installedRow("gamma", true),
    ]);
    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8")).skills).toEqual({
      includeSkills: ["kept"],
      ignoredSkills: ["existing"],
    });
  } finally {
    client.close();
  }
});

test("refuses a name that is not installed and writes nothing", async () => {
  const fixture = await startFixture();

  const client = await connect(fixture.url);
  try {
    client.send({ type: "setInstalledSkillEnabled", name: "not-installed", enabled: false });
    const error = await client.waitFor((frame) => frame.type === "error");
    expect(error.message).toContain('No skill named "not-installed" is installed.');
    const state = await client.waitFor((frame) => frame.type === "installedSkills");
    expect(state.skills).toEqual([
      installedRow("alpha", true),
      installedRow("beta", true),
      installedRow("gamma", true),
    ]);
  } finally {
    client.close();
  }
  await expect(readFile(fixture.settingsPath)).rejects.toThrow();
});

test("toggling leaves every SKILL.md and every skill directory untouched", async () => {
  const fixture = await startFixture();
  const before = await readdir(fixture.skillsDir);
  const bytesBefore = readFileSync(join(fixture.skillsDir, "beta", "SKILL.md"));

  const client = await connect(fixture.url);
  try {
    client.send({ type: "setInstalledSkillEnabled", name: "beta", enabled: false });
    await client.waitFor((frame) => frame.type === "installedSkills");
  } finally {
    client.close();
  }

  expect(await readdir(fixture.skillsDir)).toEqual(before);
  expect(readFileSync(join(fixture.skillsDir, "beta", "SKILL.md")).equals(bytesBefore)).toBe(true);
});

async function writeSkill(fixture: Fixture, name: string, source: string): Promise<void> {
  await mkdir(join(fixture.skillsDir, name), { recursive: true });
  await writeFile(join(fixture.skillsDir, name, "SKILL.md"), source);
}

test("classifies exactly the package built-ins and only prepare-family rows as deletable", async () => {
  const fixture = await startFixture([]);
  const builtins = [
    "devboard-ui-ux",
    "devboard-restful-api-implementation",
    "devboard-single-responsibility-principle",
  ];
  for (const name of builtins) {
    await writeSkill(fixture, name, builtinSkillSource(name));
  }
  await writeSkill(fixture, "tidy-commits", managedSkillSource("tidy-commits", "prepare"));
  await writeSkill(fixture, "legacy-prepared", managedSkillSource("legacy-prepared"));
  await writeSkill(fixture, "discover-naming", managedSkillSource("discover-naming", "discover"));
  await writeSkill(fixture, "house-style", skillSource("house-style"));
  await symlink("tidy-commits", join(fixture.skillsDir, "linked-conventions"));

  const rows = await skillsState(fixture.url);
  expect(
    rows.map((row) => ({
      name: row.name,
      builtin: row.builtin,
      deletable: row.deletable,
    })),
  ).toEqual([
    { name: "devboard-restful-api-implementation", builtin: true, deletable: false },
    { name: "devboard-single-responsibility-principle", builtin: true, deletable: false },
    { name: "devboard-ui-ux", builtin: true, deletable: false },
    { name: "discover-naming", builtin: false, deletable: false },
    { name: "house-style", builtin: false, deletable: false },
    { name: "legacy-prepared", builtin: false, deletable: true },
    { name: "linked-conventions", builtin: false, deletable: false },
    { name: "tidy-commits", builtin: false, deletable: true },
  ]);
});

test("deleting a prepared skill removes its directory, both tables, and its ignored name", async () => {
  const fixture = await startFixture([]);
  await writeSkill(fixture, "tidy-commits", managedSkillSource("tidy-commits", "prepare"));
  await writeSkill(fixture, "keep-me", managedSkillSource("keep-me", "prepare"));
  await mkdir(join(fixture.root, ".omp"), { recursive: true });
  await writeFile(
    fixture.settingsPath,
    `${JSON.stringify({
      modelRoles: { commit: "provider/model" },
      skills: { includeSkills: ["kept"], ignoredSkills: ["tidy-commits", "other"] },
      unrelated: { keep: true },
    })}\n`,
  );
  const client = await connect(fixture.url);
  try {
    client.send({ type: "deleteSkill", name: "tidy-commits" });
    const installed = await client.waitFor((frame) => frame.type === "installedSkills");
    expect(installed.skills).toEqual([
      installedRow("keep-me", true, managedSkillSource("keep-me", "prepare"), { deletable: true }),
    ]);
    const state = await client.waitFor((frame) => frame.type === "skillsState");
    expect((state.skills as Array<{ name: string }>).map((row) => row.name)).toEqual(["keep-me"]);

    await expect(lstat(join(fixture.skillsDir, "tidy-commits"))).rejects.toThrow();
    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toEqual({
      modelRoles: { commit: "provider/model" },
      skills: { includeSkills: ["kept"], ignoredSkills: ["other"] },
      unrelated: { keep: true },
    });

    // An enabled skill has no exclusion, so deleting it leaves the settings
    // exactly as the first deletion wrote them.
    client.send({ type: "deleteSkill", name: "keep-me" });
    const afterSecond = await client.waitFor((frame) => frame.type === "installedSkills");
    expect(afterSecond.skills).toEqual([]);
    await expect(lstat(join(fixture.skillsDir, "keep-me"))).rejects.toThrow();
    expect(JSON.parse(await readFile(fixture.settingsPath, "utf8"))).toEqual({
      modelRoles: { commit: "provider/model" },
      skills: { includeSkills: ["kept"], ignoredSkills: ["other"] },
      unrelated: { keep: true },
    });
  } finally {
    client.close();
  }
});

test("deleting an enabled skill writes no settings file at all", async () => {
  const fixture = await startFixture([]);
  await writeSkill(fixture, "tidy-commits", managedSkillSource("tidy-commits", "prepare"));

  const client = await connect(fixture.url);
  try {
    client.send({ type: "deleteSkill", name: "tidy-commits" });
    const installed = await client.waitFor((frame) => frame.type === "installedSkills");
    expect(installed.skills).toEqual([]);
  } finally {
    client.close();
  }
  await expect(readFile(fixture.settingsPath)).rejects.toThrow();
});

test("refuses built-in, Discover, hand-authored, symlinked, and unknown names untouched", async () => {
  const fixture = await startFixture([]);
  await writeSkill(fixture, "devboard-ui-ux", builtinSkillSource("devboard-ui-ux"));
  await writeSkill(fixture, "discover-naming", managedSkillSource("discover-naming", "discover"));
  await writeSkill(fixture, "house-style", skillSource("house-style"));
  await writeSkill(fixture, "tidy-commits", managedSkillSource("tidy-commits", "prepare"));
  await symlink("tidy-commits", join(fixture.skillsDir, "linked-conventions"));
  await mkdir(join(fixture.root, ".omp"), { recursive: true });
  const settings = `${JSON.stringify({ skills: { ignoredSkills: ["kept"] } })}\n`;
  await writeFile(fixture.settingsPath, settings);

  const client = await connect(fixture.url);
  try {
    for (const [name, message] of [
      ["devboard-ui-ux", '"devboard-ui-ux" is a built-in skill and cannot be deleted.'],
      ["discover-naming", 'No prepared skill named "discover-naming" is installed.'],
      ["house-style", 'No prepared skill named "house-style" is installed.'],
      ["linked-conventions", 'No prepared skill named "linked-conventions" is installed.'],
      ["not-installed", 'No prepared skill named "not-installed" is installed.'],
    ] as const) {
      client.send({ type: "deleteSkill", name });
      const error = await client.waitFor((frame) => frame.type === "error");
      expect(String(error.message)).toBe(message);
      const state = await client.waitFor((frame) => frame.type === "installedSkills");
      const names = (state.skills as Array<{ name: string }>).map((row) => row.name);
      if (name === "not-installed") {
        expect(names).not.toContain(name);
      } else {
        expect(names).toContain(name);
      }
    }

    client.send({ type: "deleteSkill", name: "../tidy-commits" });
    const invalid = await client.waitFor((frame) => frame.type === "error");
    expect(String(invalid.message)).toBe("Choose a prepared skill to delete.");

    for (const name of ["devboard-ui-ux", "discover-naming", "house-style", "tidy-commits"]) {
      expect((await lstat(join(fixture.skillsDir, name))).isDirectory()).toBe(true);
    }
    expect(lstatSync(join(fixture.skillsDir, "linked-conventions")).isSymbolicLink()).toBe(true);
    expect(await readFile(fixture.settingsPath, "utf8")).toBe(settings);
  } finally {
    client.close();
  }
});

test("refuses every delete while a skills preparation is active", async () => {
  const fixture = await startFixture([], {
    agentArguments: "--prepare-skills --delay-ms=1500",
  });
  await writeSkill(fixture, "house-style", skillSource("house-style"));

  const client = await connect(fixture.url);
  try {
    client.send({ type: "prepareSkills" });
    await client.waitFor((frame) => frame.type === "skillsPreparationStarted");
    client.send({ type: "deleteSkill", name: "house-style" });
    const error = await client.waitFor((frame) => frame.type === "error");
    expect(String(error.message)).toBe(
      "Cannot delete a skill while skills preparation is active.",
    );
    const state = await client.waitFor((frame) => frame.type === "installedSkills");
    expect((state.skills as Array<{ name: string }>).map((row) => row.name)).toContain("house-style");
    expect((await lstat(join(fixture.skillsDir, "house-style"))).isDirectory()).toBe(true);
    await client.waitFor((frame) => frame.type === "skillsPreparationStopped");
  } finally {
    client.close();
  }
});
