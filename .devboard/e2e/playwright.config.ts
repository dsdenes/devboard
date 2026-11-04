import path from "node:path";

import { defineConfig } from "@playwright/test";

// The browser stays inside the repository: a fresh checkout installs it with
// `PLAYWRIGHT_BROWSERS_PATH=.devboard/.tmp/ms-playwright bunx playwright install chromium`.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(
  import.meta.dirname,
  "..",
  ".tmp",
  "ms-playwright",
);

/**
 * The operator suite: one serial browser session against the built dashboard.
 *
 * It is a proof an operator runs, not a CI gate. The global setup builds the
 * fixture repository, warms each family once, starts the real `devboard
 * serve` binary, and writes its report and traces under
 * `.devboard/.tmp/e2e/`.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    [
      "json",
      { outputFile: path.join(import.meta.dirname, "..", ".tmp", "e2e", "report.json") },
    ],
  ],
  outputDir: path.join(import.meta.dirname, "..", ".tmp", "e2e", "test-results"),
  globalSetup: path.join(import.meta.dirname, "global-setup.ts"),
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1365, height: 768 },
  },
});
