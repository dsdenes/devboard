/**
 * The operator suite's config at the package root, so
 * `bunx playwright test e2e/delivery-mode.e2e.ts` finds the e2e directory
 * without an explicit `--config`. The suite's own config owns every setting.
 */
export { default } from "./e2e/playwright.config";
