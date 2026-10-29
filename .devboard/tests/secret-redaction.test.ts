import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../lib/secret-redaction";

const OPENCODE_GO_KEY = "oc_sk_live_0123456789abcdef0123456789abcdef";
const OPENROUTER_KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

describe("secret redaction", () => {
  test("replaces a provider key supplied only through the credential set", () => {
    const key = "provider-store-only-key-0001";
    const text = `export OPENCODE_API_KEY=${key} && run the agent`;

    expect(redactSecrets(text, {}, [key])).toBe(
      "export OPENCODE_API_KEY=<redacted> && run the agent",
    );
  });

  test("keeps redacting credentials named in the environment", () => {
    const secret = "environment-only-secret-value";

    expect(redactSecrets(`token ${secret}`, { FIXTURE_TOKEN: secret })).toBe(
      "token <redacted>",
    );
  });

  test("recognizes OpenCode Go and OpenRouter key shapes", () => {
    expect(redactSecrets(`key ${OPENCODE_GO_KEY} end`, {})).toBe("key <redacted> end");
    expect(redactSecrets(`key ${OPENROUTER_KEY} end`, {})).toBe("key <redacted> end");
  });

  test("replaces the longest registered value first", () => {
    const short = "abcdefgh";
    const long = `${short}ijkl`;

    expect(redactSecrets(`value ${long}`, {}, [short, long])).toBe("value <redacted>");
  });
});
