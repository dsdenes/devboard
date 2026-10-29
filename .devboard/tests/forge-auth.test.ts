import { describe, expect, test } from "bun:test";
import {
  authEnvironment,
  isAuthFailure,
  resolveForgeAuth,
  spawnExec,
  type Exec,
  type ResolvedAuth,
} from "../lib/forge-auth.ts";
import { parseForgeRemote } from "../lib/forge.ts";

interface Account {
  login: string;
  token: string;
  active?: boolean;
  state?: string;
  error?: string;
  tokenFailure?: boolean;
  permissions?: Record<string, boolean>;
}

interface GithubConfig {
  accounts: Account[];
  users?: Record<string, string>;
  envPermissions?: Record<string, Record<string, boolean>>;
}

function githubExec(config: GithubConfig): Exec {
  return async (command, args, options) => {
    const key = [command, ...args].join(" ");
    if (command === "gh" && key === "gh auth status --hostname github.com --json hosts") {
      return {
        stdout: JSON.stringify({
          hosts: {
            "github.com": config.accounts.map((account) => ({
              login: account.login,
              active: account.active ?? false,
              state: account.state ?? "success",
              error: account.error ?? "",
            })),
          },
        }),
        stderr: "",
        code: 0,
      };
    }
    if (command === "gh" && args[0] === "auth" && args[1] === "token") {
      const login = args[args.indexOf("--user") + 1];
      const account = config.accounts.find((entry) => entry.login === login);
      if (account === undefined || account.tokenFailure === true) {
        return { stdout: "", stderr: "token unavailable", code: 1 };
      }
      return { stdout: `${account.token}\n`, stderr: "", code: 0 };
    }
    if (command === "gh" && args[0] === "api") {
      const token = options.env?.GH_TOKEN ?? "";
      const account = config.accounts.find((entry) => entry.token === token);
      const envLogin = config.users?.[token];
      if (args.includes("user")) {
        const login = account?.login ?? envLogin;
        return login === undefined
          ? { stdout: "", stderr: "Bad credentials (HTTP 401)", code: 1 }
          : { stdout: `${login}\n`, stderr: "", code: 0 };
      }
      const permission = account?.permissions ?? config.envPermissions?.[token];
      if (permission === undefined) {
        return { stdout: "", stderr: "Not Found (HTTP 404)", code: 1 };
      }
      return { stdout: JSON.stringify(permission), stderr: "", code: 0 };
    }
    return { stdout: "", stderr: `unexpected: ${key}`, code: 1 };
  };
}

const WRITE = { admin: false, maintain: false, push: true, triage: true, pull: true };
const READ = { admin: false, maintain: false, push: false, triage: false, pull: true };

function options(env: Record<string, string | undefined> = {}) {
  return {
    forge: "github" as const,
    host: "github.com",
    project: "owner/repo",
    cwd: "/repo",
    required: "write" as const,
    env,
  };
}

function resolved(value: Awaited<ReturnType<typeof resolveForgeAuth>>): ResolvedAuth {
  if (isAuthFailure(value)) throw new Error(value.error);
  return value;
}

describe("GitHub identity selection", () => {
  test("prefers the owner account with write access over an active read-only account", async () => {
    const auth = resolved(
      await resolveForgeAuth(
        githubExec({
          accounts: [
            { login: "other-user", token: "gho_active", active: true, permissions: READ },
            { login: "owner", token: "gho_owner", permissions: WRITE },
          ],
        }),
        options(),
      ),
    );

    expect(auth.login).toBe("owner");
    expect(auth.source).toBe("gh account");
    expect(auth.permission).toBe("push");
    expect(auth.canWrite).toBe(true);
  });

  test("ignores a stale environment token and uses a stored write-capable account", async () => {
    const result = await resolveForgeAuth(
      githubExec({
        accounts: [{ login: "owner", token: "gho_owner", permissions: WRITE }],
      }),
      options({ GH_TOKEN: "stale" }),
    );

    const auth = resolved(result);
    expect(auth.login).toBe("owner");
    expect(auth.token).toBe("gho_owner");
  });

  test("uses a valid environment token when it is the only write-capable credential", async () => {
    const auth = resolved(
      await resolveForgeAuth(
        githubExec({
          accounts: [{ login: "owner", token: "gho_owner", permissions: READ }],
          users: { gho_env: "operator" },
          envPermissions: { gho_env: WRITE },
        }),
        options({ GH_TOKEN: "gho_env" }),
      ),
    );

    expect(auth.login).toBe("operator");
    expect(auth.source).toBe("GH_TOKEN");
    expect(auth.canWrite).toBe(true);
  });

  test("fails with every tested account when none can write", async () => {
    const result = await resolveForgeAuth(
      githubExec({
        accounts: [
          { login: "active", token: "gho_active", active: true, permissions: READ },
          { login: "owner", token: "gho_owner", permissions: READ },
        ],
      }),
      options({ GH_TOKEN: "stale" }),
    );

    if (!isAuthFailure(result)) throw new Error("expected a failure");
    expect(result.error).toContain("no authenticated GitHub account has write access to owner/repo");
    expect(result.error).toContain("GH_TOKEN: token rejected");
    expect(result.error).toContain("active (gh account): pull access only");
    expect(result.error).toContain("owner (gh account): pull access only");
    expect(result.error).not.toContain("stale");
    expect(result.error).not.toContain("gho_");
    expect(result.error).toContain("gh auth login --hostname github.com");
  });

  test("prefers the active account on equal capability", async () => {
    const auth = resolved(
      await resolveForgeAuth(
        githubExec({
          accounts: [
            { login: "available", token: "gho_available", permissions: WRITE },
            { login: "active", token: "gho_active", active: true, permissions: WRITE },
          ],
        }),
        options(),
      ),
    );

    expect(auth.login).toBe("active");
  });

  test("continues when one account exposes no token", async () => {
    const auth = resolved(
      await resolveForgeAuth(
        githubExec({
          accounts: [
            { login: "broken", token: "gho_broken", tokenFailure: true },
            { login: "owner", token: "gho_owner", permissions: WRITE },
          ],
        }),
        options(),
      ),
    );

    expect(auth.login).toBe("owner");
  });

  test("accepts a read-only account when read access is all that is required", async () => {
    const auth = resolved(
      await resolveForgeAuth(
        githubExec({
          accounts: [{ login: "owner", token: "gho_owner", permissions: READ }],
        }),
        { ...options(), required: "read" },
      ),
    );

    expect(auth.permission).toBe("pull");
    expect(auth.canWrite).toBe(false);
  });

  test("reports an unavailable gh instead of guessing", async () => {
    const result = await resolveForgeAuth(
      async () => ({ stdout: "", stderr: "gh: not found", code: 127 }),
      options(),
    );

    if (!isAuthFailure(result)) throw new Error("expected a failure");
    expect(result.error).toContain("gh is unavailable");
  });
});

function gitlabExec(options: {
  storedToken?: string;
  storedAccess?: number;
  environmentAccess?: number;
}): Exec {
  const storedToken = options.storedToken ?? "glpat-stored";
  return async (command, args, execOptions) => {
    const key = [command, ...args].join(" ");
    if (command === "glab" && key === "glab auth status --hostname gitlab.com --show-token") {
      return { stdout: `  ✓ Token: ${storedToken}\n`, stderr: "", code: 0 };
    }
    if (command === "glab" && args[0] === "api") {
      const token = execOptions.env?.GITLAB_TOKEN;
      if (args.includes("user")) {
        return token === undefined || token === storedToken || token === "glpat-env"
          ? { stdout: JSON.stringify({ username: "gitlab-user" }), stderr: "", code: 0 }
          : { stdout: "", stderr: "401 Unauthorized", code: 1 };
      }
      const access = token === "glpat-env" ? (options.environmentAccess ?? 40) : (options.storedAccess ?? 40);
      return {
        stdout: JSON.stringify({
          visibility: "private",
          permissions: { project_access: { access_level: access } },
        }),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: `unexpected: ${key}`, code: 1 };
  };
}

describe("GitLab identity selection", () => {
  test("uses the stored token and verifies project access", async () => {
    const auth = resolved(
      await resolveForgeAuth(gitlabExec({ storedAccess: 40 }), {
        forge: "gitlab",
        host: "gitlab.com",
        project: "group/sub/project",
        cwd: "/repo",
        required: "write",
        env: {},
      }),
    );

    expect(auth.login).toBe("gitlab-user");
    expect(auth.token).toBe("glpat-stored");
    expect(auth.permission).toBe("maintain");
  });

  test("ignores an invalid environment token and falls back to the store", async () => {
    const auth = resolved(
      await resolveForgeAuth(gitlabExec({ storedAccess: 40 }), {
        forge: "gitlab",
        host: "gitlab.com",
        project: "group/sub/project",
        cwd: "/repo",
        required: "write",
        env: { GITLAB_TOKEN: "glpat-bad" },
      }),
    );

    expect(auth.source).toBe("glab token");
    expect(auth.token).toBe("glpat-stored");
  });

  test("probes the subgroup project parsed from the origin remote", async () => {
    const remote = parseForgeRemote("git@gitlab.com:group/sub/project.git", {});
    if (remote === undefined) throw new Error("subgroup remote did not parse");

    const calls: string[] = [];
    const exec = gitlabExec({ storedAccess: 40 });
    const auth = resolved(
      await resolveForgeAuth(
        async (command, args, execOptions) => {
          calls.push([command, ...args].join(" "));
          return exec(command, args, execOptions);
        },
        {
          forge: remote.forge,
          host: remote.host,
          project: remote.project,
          cwd: "/repo",
          required: "write",
          env: {},
        },
      ),
    );

    expect(auth.project).toBe("group/sub/project");
    expect(calls).toContain("glab api --hostname gitlab.com projects/group%2Fsub%2Fproject");
  });
});

describe("authEnvironment", () => {
  test("removes every competing GitHub token and pins the host", () => {
    const auth: ResolvedAuth = {
      forge: "github",
      host: "github.com",
      project: "owner/repo",
      login: "owner",
      token: "gho_selected",
      source: "gh account",
      active: true,
      permission: "push",
      canWrite: true,
    };
    const environment = authEnvironment(auth, {
      PATH: "/bin",
      GH_TOKEN: "stale",
      GITHUB_TOKEN: "other",
      GH_ENTERPRISE_TOKEN: "enterprise",
      GITHUB_ENTERPRISE_TOKEN: "enterprise2",
      GH_HOST: "elsewhere.example",
    });

    expect(environment.GH_TOKEN).toBe("gho_selected");
    expect(environment.GH_HOST).toBe("github.com");
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(environment.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
    expect(environment.PATH).toBe("/bin");
  });

  test("uses enterprise variables for a self-hosted GitHub host", () => {
    const auth: ResolvedAuth = {
      forge: "github",
      host: "ghe.example.com",
      project: "owner/repo",
      login: "owner",
      token: "gho_selected",
      source: "gh account",
      active: true,
      permission: "push",
      canWrite: true,
    };
    const environment = authEnvironment(auth, {
      GH_TOKEN: "stale",
      GITHUB_TOKEN: "other",
      GH_ENTERPRISE_TOKEN: "enterprise-stale",
    });

    expect(environment.GH_TOKEN).toBe("gho_selected");
    expect(environment.GH_ENTERPRISE_TOKEN).toBe("gho_selected");
    expect(environment.GITHUB_ENTERPRISE_TOKEN).toBe("gho_selected");
    expect(environment.GH_HOST).toBe("ghe.example.com");
  });

  test("removes GitLab token overrides when the store supplies the credential", () => {
    const auth: ResolvedAuth = {
      forge: "gitlab",
      host: "gitlab.com",
      project: "group/project",
      login: "user",
      source: "glab credential store",
      active: true,
      permission: "push",
      canWrite: true,
    };
    const environment = authEnvironment(auth, {
      GITLAB_TOKEN: "stale",
      GITLAB_ACCESS_TOKEN: "other",
      OAUTH_TOKEN: "oauth",
    });

    expect(environment.GITLAB_TOKEN).toBeUndefined();
    expect(environment.GITLAB_ACCESS_TOKEN).toBeUndefined();
    expect(environment.OAUTH_TOKEN).toBeUndefined();
    expect(environment.GITLAB_HOST).toBe("gitlab.com");
  });
});

describe("The default executor's deadline", () => {
  test("kills a child that outlives its timeout and settles without waiting for it", async () => {
    // The bound under test is a real wall-clock deadline on a real child, so
    // fake timers cannot drive it.
    const started = Date.now();
    const result = await spawnExec("bun", ["-e", "setTimeout(() => {}, 60_000)"], {
      cwd: import.meta.dir,
      timeout: 100,
    });

    expect(result.killed).toBe(true);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test("kills a child when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = spawnExec("bun", ["-e", "setTimeout(() => {}, 60_000)"], {
      cwd: import.meta.dir,
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    expect(result.killed).toBe(true);
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain("aborted");
  }, 10_000);

  test("returns the output of a child that finishes inside its bound", async () => {
    const result = await spawnExec("bun", ["-e", "console.log('inside')"], {
      cwd: import.meta.dir,
      timeout: 10_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("inside");
    expect(result.killed).toBe(false);
  }, 10_000);
});
