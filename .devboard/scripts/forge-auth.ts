#!/usr/bin/env bun
/**
 * `forge-auth` — resolve the one forge credential an agent should use, or run
 * a forge command with it.
 *
 * Prompts call this instead of `gh`/`glab` directly so every tracker read and
 * write goes through the same verified identity. `exec` places the selected
 * token in the child environment only: it never appears in an argument, a log
 * line, or an error.
 */

import {
  authEnvironment,
  isAuthFailure,
  resolveForgeAuth,
  type AuthOutcome,
  type Exec,
  type Forge,
  type RequiredAccess,
} from "../lib/forge-auth.ts";

const USAGE = `Usage:
  forge-auth check --host <host> --project <owner/repo> [options]
  forge-auth exec  --host <host> --project <owner/repo> [options] -- <gh|glab> <args...>

Options:
  --host <host>        forge hostname, e.g. github.com
  --project <path>     repository path, e.g. owner/repo or group/sub/project
  --forge <name>       github, gitlab, or gitea; inferred from the host when omitted
  --required <access>  read or write; default read
  --cwd <path>         working directory; default the current directory
  --url <url>          Gitea HTTP origin; defaults to DEVBOARD_GITEA_URL
  --json               machine-readable check output (check only)
  --quiet              suppress the selected-identity line on stderr
  -h, --help           show this help

Exit status: 0 when a credential was selected and the command succeeded;
1 when no authenticated account meets the requirement; 2 on usage errors.
`;

interface Parsed {
  action: "check" | "exec";
  host: string;
  project: string;
  forge?: Forge;
  required: RequiredAccess;
  cwd: string;
  url?: string;
  json: boolean;
  quiet: boolean;
  command: string[];
}

function fail(message: string, status = 2): never {
  process.stderr.write(`forge-auth: ${message}\n\n${USAGE}`);
  process.exit(status);
}

function parse(args: string[]): Parsed {
  const [action, ...rest] = args;
  if (action === undefined || action === "-h" || action === "--help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (action !== "check" && action !== "exec") {
    fail(`unknown action: ${action}`);
  }

  let host: string | undefined;
  let project: string | undefined;
  let forge: Forge | undefined;
  let required: RequiredAccess = "read";
  let cwd = process.cwd();
  let url: string | undefined;
  let json = false;
  let quiet = false;
  const command: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    switch (argument) {
      case "--": {
        command.push(...rest.slice(index + 1));
        index = rest.length;
        break;
      }
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
      case "--host":
        host = rest[++index];
        break;
      case "--project":
        project = rest[++index];
        break;
      case "--forge": {
        const value = rest[++index];
        if (value !== "github" && value !== "gitlab" && value !== "gitea") {
          fail(`--forge must be github, gitlab, or gitea, got: ${value ?? "nothing"}`);
        }
        forge = value;
        break;
      }
      case "--required": {
        const value = rest[++index];
        if (value !== "read" && value !== "write") {
          fail(`--required must be read or write, got: ${value ?? "nothing"}`);
        }
        required = value;
        break;
      }
      case "--cwd":
        cwd = rest[++index] ?? cwd;
        break;
      case "--url":
        url = rest[++index];
        break;
      case "--json":
        json = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      default:
        if (argument !== undefined && argument.startsWith("-")) {
          fail(`unknown option: ${argument}`);
        }
        fail(`unexpected argument: ${argument ?? ""}`);
    }
  }

  if (host === undefined || host.trim().length === 0) fail("--host is required");
  if (project === undefined || project.trim().length === 0) fail("--project is required");
  if (action === "exec" && command.length === 0) {
    fail("exec requires a command after --");
  }
  return {
    action,
    host: host.trim(),
    project: project.trim().replace(/^\/+|\/+$/g, ""),
    forge,
    required,
    cwd,
    ...(url === undefined ? {} : { url }),
    json,
    quiet,
    command,
  };
}

const bunExec: Exec = async (command, args, options) => {
  try {
    const child = Bun.spawn({
      cmd: [command, ...args],
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      killed: false,
    };
  }
};

async function resolve(parsed: Parsed): Promise<AuthOutcome> {
  const common = {
    host: parsed.host,
    project: parsed.project,
    cwd: parsed.cwd,
    required: parsed.required,
    env: process.env,
    ...(parsed.url === undefined ? {} : { baseUrl: parsed.url }),
  };
  if (parsed.forge !== undefined) {
    return resolveForgeAuth(bunExec, { ...common, forge: parsed.forge });
  }
  const lower = parsed.host.toLowerCase();
  if (lower === "github.com") {
    return resolveForgeAuth(bunExec, { ...common, forge: "github" });
  }
  if (lower.includes("gitlab")) {
    return resolveForgeAuth(bunExec, { ...common, forge: "gitlab" });
  }

  const github = await resolveForgeAuth(bunExec, { ...common, forge: "github" });
  const gitlab = await resolveForgeAuth(bunExec, { ...common, forge: "gitlab" });
  if (!isAuthFailure(github)) return github;
  if (!isAuthFailure(gitlab)) return gitlab;
  // Every other host is a Gitea instance; its public API or token decides.
  const gitea = await resolveForgeAuth(bunExec, { ...common, forge: "gitea" });
  if (!isAuthFailure(gitea)) return gitea;
  return {
    error: [
      `no authenticated forge account has ${parsed.required} access to ${parsed.project} on ${parsed.host}`,
      `gh: ${github.error}`,
      `glab: ${gitlab.error}`,
      `gitea: ${gitea.error}`,
    ].join("\n"),
  };
}

function report(auth: Exclude<AuthOutcome, { error: string }>, parsed: Parsed): void {
  if (parsed.action === "check" && parsed.json) {
    process.stdout.write(
      `${JSON.stringify({
        forge: auth.forge,
        host: auth.host,
        project: auth.project,
        login: auth.login,
        source: auth.source,
        active: auth.active,
        permission: auth.permission,
        canWrite: auth.canWrite,
      })}\n`,
    );
    return;
  }
  if (parsed.action === "check") {
    process.stdout.write(
      `${auth.host} ${auth.project}: ${auth.login} (${auth.permission}` +
        `${auth.active ? ", active" : ""}) via ${auth.source}\n`,
    );
  }
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  const auth = await resolve(parsed);
  if (isAuthFailure(auth)) {
    process.stderr.write(`${auth.error}\n`);
    process.exit(1);
  }

  report(auth, parsed);
  if (parsed.action === "check") return;

  const [executable, ...args] = parsed.command;
  if (auth.forge === "gitea") {
    process.stderr.write(
      "forge-auth: Gitea writes use its HTTP API; run 'check' for the selected identity\n",
    );
    process.exit(2);
  }
  const expected = auth.forge === "github" ? "gh" : "glab";
  const name = executable?.split("/").pop();
  if (name !== expected) {
    process.stderr.write(
      `forge-auth: ${auth.forge} requires ${expected}, got ${executable ?? "nothing"}\n`,
    );
    process.exit(2);
  }
  if (!parsed.quiet) {
    process.stderr.write(
      `forge-auth: using ${auth.login} (${auth.permission}) for ${auth.host}/${auth.project}\n`,
    );
  }

  let child: Bun.Subprocess<"inherit", "inherit", "inherit">;
  try {
    child = Bun.spawn({
      cmd: [executable, ...args],
      cwd: parsed.cwd,
      env: authEnvironment(auth),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    process.stderr.write(
      `forge-auth: could not run ${executable}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(127);
  }
  process.exit(await child.exited);
}

if (import.meta.main) {
  await main();
}
