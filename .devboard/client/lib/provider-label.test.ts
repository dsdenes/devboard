import { describe, expect, test } from "bun:test";
import { providerIndicatorLabel, providerIndicatorTitle } from "./provider-label";
import type { ProviderSelection } from "./types";

const selection: ProviderSelection = {
  provider: "opencode-go",
  providerName: "opencode-go",
  label: "work",
  model: "deepseek-v4.1",
  remainingFraction: 0.825,
};

describe("provider indicator label", () => {
  test("names the selected provider and its remaining share", () => {
    expect(providerIndicatorLabel(selection)).toBe("opencode-go · 82.5%");
  });

  test("reports no provider when nothing is selected", () => {
    expect(providerIndicatorLabel(null)).toBe("No provider");
  });
});

describe("provider indicator title", () => {
  test("states the provider, label, model, remainder, and rotation rule", () => {
    expect(
      providerIndicatorTitle({
        selection,
        refusal: null,
        rule: "rotates at 1% remaining",
      }),
    ).toBe(
      "opencode-go (work) serves peers on deepseek-v4.1; 82.5% remaining. rotates at 1% remaining.",
    );
  });

  test("keeps the server's refusal when nothing is selected", () => {
    expect(
      providerIndicatorTitle({
        selection: null,
        refusal: "No provider",
        rule: "rotates at 1% remaining",
      }),
    ).toBe("No provider");
  });

  test("falls back to the configured sentence without a refusal", () => {
    expect(
      providerIndicatorTitle({
        selection: null,
        refusal: null,
        rule: "rotates at 1% remaining",
      }),
    ).toBe("No provider subscription is configured. Open the Providers dialog.");
  });
});
