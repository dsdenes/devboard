import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createForgeIssues } from "../lib/forge-issues";
import { redactSecrets } from "../lib/secret-redaction";
import { originForge } from "../issues/repository";
import type { McpOptimizerOpenIssue } from "./issue";
import { registeredProviderSecrets } from "./providers";

/**
 * MCP optimizer issue delivery. It uses the harness forge-auth path through the shared
 * forge client, redacts every unseen secret before the bytes leave the
 * process, and never closes, reopens, renames, or comments on an issue. The
 * deduplication read is the same client: the open issues, with their bodies.
 *
 * A verification run injects `DEVBOARD_MCP_OPTIMIZER_FORGE_STUB=<directory>`: the
 * delivery then records each call in `calls.jsonl`, answers a deterministic
 * issue URL, and lists the issues it created, so no test contacts a real
 * forge.
 */

export type DeliveryResult = { ok: true; url: string } | { ok: false; reason: string };

export interface McpOptimizerDelivery {
  repository: string;
  /** Every open issue, with the body deduplication reads. */
  list(): Promise<McpOptimizerOpenIssue[]>;
  create(title: string, body: string): Promise<DeliveryResult>;
}

export interface McpOptimizerDeliveryOptions {
  repoDir: string;
  /** The dashboard state; the provider credential store lives under it. */
  stateDir: string;
  environment?: Record<string, string | undefined>;
}

export const MCP_OPTIMIZER_FORGE_STUB_ENV = "DEVBOARD_MCP_OPTIMIZER_FORGE_STUB";

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

interface StubCall {
  op: "create";
  title?: string;
  body: string;
  url?: string;
}

function readCalls(directory: string): StubCall[] {
  try {
    return readFileSync(join(directory, "calls.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null) return [];
          const record = parsed as Record<string, unknown>;
          if (record.op !== "create") return [];
          return [
            {
              op: "create",
              body: typeof record.body === "string" ? record.body : "",
              ...(typeof record.title === "string" ? { title: record.title } : {}),
              ...(typeof record.url === "string" ? { url: record.url } : {}),
            },
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function stubDelivery(
  directory: string,
  repository: string,
  redact: (text: string) => string,
): McpOptimizerDelivery {
  const target = resolve(directory);
  const record = (call: StubCall): void => {
    mkdirSync(target, { recursive: true });
    appendFileSync(join(target, "calls.jsonl"), `${JSON.stringify(call)}\n`);
  };
  const nextNumber = (): number => readCalls(target).length + 1;
  return {
    repository,
    async list() {
      return readCalls(target).map((call, index) => ({
        number: index + 1,
        title: call.title ?? "",
        body: call.body,
        url: call.url ?? `https://forge.test/${repository}/issues/${index + 1}`,
      }));
    },
    async create(title, body) {
      const redactedTitle = redact(title);
      const redactedBody = redact(body);
      const number = nextNumber();
      const url = `https://forge.test/${repository}/issues/${number}`;
      record({ op: "create", title: redactedTitle, body: redactedBody, url });
      return { ok: true, url };
    },
  };
}

/** The delivery for this checkout's origin, or the injected stub. */
export function createMcpOptimizerDelivery(options: McpOptimizerDeliveryOptions): McpOptimizerDelivery {
  const environment = options.environment ?? process.env;
  // Peers receive these keys from the credential store, so a transcript can
  // echo a secret the worker process itself never held.
  const secrets = registeredProviderSecrets(options.stateDir, environment);
  const redact = (text: string): string => redactSecrets(text, environment, secrets);
  const remote = originForge(options.repoDir, environment);
  const repository = remote?.project ?? "fixture/fixture";
  const stub = environment[MCP_OPTIMIZER_FORGE_STUB_ENV];
  if (typeof stub === "string" && stub.length > 0) {
    return stubDelivery(stub, repository, redact);
  }
  const forge = createForgeIssues({
    repoDir: options.repoDir,
    environment,
  });
  return {
    repository: forge.repository,
    async list() {
      const summaries = await forge.list("open", 100);
      const issues: McpOptimizerOpenIssue[] = [];
      for (const summary of summaries) {
        const document = await forge.get(summary.number);
        issues.push({
          number: document.number,
          title: document.title,
          body: document.body,
          url: document.url,
        });
      }
      return issues;
    },
    async create(title, body) {
      try {
        const issue = await forge.create({
          title: redact(title),
          body: redact(body),
        });
        return { ok: true, url: issue.url };
      } catch (error) {
        return { ok: false, reason: redact(firstLine(error)) };
      }
    },
  };
}
