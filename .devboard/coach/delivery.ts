import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createForgeIssues } from "../lib/forge-issues";
import { redactSecrets } from "../lib/secret-redaction";
import { originForge } from "../issues/repository";
import { registeredProviderSecrets } from "./providers";

/**
 * Coach issue delivery. It uses the harness forge-auth path through the shared
 * forge client, redacts every unseen secret before the bytes leave the
 * process, and never closes, reopens, or renames an issue.
 *
 * A verification run injects `DEVBOARD_COACH_FORGE_STUB=<directory>`: the
 * delivery then records each call in `calls.jsonl` and answers a deterministic
 * issue URL, so no test contacts a real forge.
 */

export type DeliveryResult = { ok: true; url: string } | { ok: false; reason: string };
export type CommentResult = { ok: true } | { ok: false; reason: string };

export interface CoachDelivery {
  repository: string;
  create(title: string, body: string): Promise<DeliveryResult>;
  comment(url: string, body: string): Promise<CommentResult>;
}

export interface CoachDeliveryOptions {
  repoDir: string;
  /** The dashboard state; the provider credential store lives under it. */
  stateDir: string;
  environment?: Record<string, string | undefined>;
}

export const COACH_FORGE_STUB_ENV = "DEVBOARD_COACH_FORGE_STUB";

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
  op: "create" | "comment";
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
          if (record.op !== "create" && record.op !== "comment") return [];
          return [
            {
              op: record.op,
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
): CoachDelivery {
  const target = resolve(directory);
  const record = (call: StubCall): void => {
    mkdirSync(target, { recursive: true });
    appendFileSync(join(target, "calls.jsonl"), `${JSON.stringify(call)}\n`);
  };
  const nextNumber = (): number => {
    const current = readCalls(target).filter((call) => call.op === "create").length;
    return current + 1;
  };
  return {
    repository,
    async create(title, body) {
      const redactedTitle = redact(title);
      const redactedBody = redact(body);
      const number = nextNumber();
      const url = `https://forge.test/${repository}/issues/${number}`;
      record({ op: "create", title: redactedTitle, body: redactedBody, url });
      return { ok: true, url };
    },
    async comment(url, body) {
      record({ op: "comment", url, body: redact(body) });
      return { ok: true };
    },
  };
}

/** The delivery for this checkout's origin, or the injected stub. */
export function createCoachDelivery(options: CoachDeliveryOptions): CoachDelivery {
  const environment = options.environment ?? process.env;
  // Peers receive these keys from the credential store, so a transcript can
  // echo a secret the worker process itself never held.
  const secrets = registeredProviderSecrets(options.stateDir, environment);
  const redact = (text: string): string => redactSecrets(text, environment, secrets);
  const remote = originForge(options.repoDir, environment);
  const repository = remote?.project ?? "fixture/fixture";
  const stub = environment[COACH_FORGE_STUB_ENV];
  if (typeof stub === "string" && stub.length > 0) {
    return stubDelivery(stub, repository, redact);
  }
  const forge = createForgeIssues({
    repoDir: options.repoDir,
    environment,
  });
  return {
    repository: forge.repository,
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
    async comment(url, body) {
      try {
        await forge.comment(url, redact(body));
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: redact(firstLine(error)) };
      }
    },
  };
}
