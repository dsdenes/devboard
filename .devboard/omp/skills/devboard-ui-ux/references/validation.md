# Validation reference

Final validation is browser evidence, not a code review. Use Playwright. Read this at Step 6 and
before making any visual or interaction claim.

## 1. Discover the run surface

Do not guess a server command. Read the project's `package.json`, README, contribution guide, and
existing E2E config. Prefer, in order:

1. The project's documented dev server and its E2E test command.
2. An existing Playwright project or `@playwright/test` config.
3. Storybook for component-level states if the page cannot be served.
4. OMP's `browser` tool as the Playwright-backed fallback.

If none can run, record `not run` in `validation.md` and state exactly what blocked it. Do not
claim the UI was visually verified.

## 2. State matrix

Exercise the primary and failure journeys from Step 0. At minimum, cover the states that the page
actually has:

| State | What to prove |
|---|---|
| Default | Primary task is obvious; P0 information is visible. |
| Loading | Layout does not jump; actions are disabled or clearly pending. |
| Empty | The user understands why it is empty and what to do next. |
| Error | The error is actionable; the user can retry or recover. |
| Partial | Missing or stale data is labeled; the page does not lie. |
| Permission-denied | The user sees why and what they can do instead. |
| Success | The result is visible; the next action is clear. |
| Long text | No clipping, overlap, or broken layout. |
| Large numbers | Formatting and alignment survive. |
| Zero/one/many | Collections and counters hold. |
| Narrow viewport | Primary action remains reachable; no horizontal scroll. |

Use representative data. Do not only test the happy path.

## 3. Playwright checks

Use the project's Playwright if present. A typical check:

```ts
import { test, expect } from "@playwright/test";

test("billing page primary journey", async ({ page }) => {
  await page.goto("/settings/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change plan" })).toBeVisible();
  await page.getByRole("button", { name: "Change plan" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
```

Also capture:

```ts
await page.screenshot({ path: ".design/ux/settings-billing/screenshots/default-desktop.png" });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: ".design/ux/settings-billing/screenshots/default-mobile.png" });
```

Adapt selectors to the project's conventions. Prefer role, label, and text selectors over CSS
classes. Do not add test IDs solely for this skill unless the project already uses them.

If using OMP's `browser` tool, open the page, exercise the same journeys, and capture the same
evidence. Do not claim Playwright ran if only a static screenshot was inspected.

## 4. Dependent pages

If a design-system component changed:

- Find every usage of the component before editing (`xd://lsp` references or the project's
  equivalent).
- Run the component's Storybook stories.
- Exercise every page that consumes the component, or the highest-risk representative pages.
- Check the states that the component supports, not just the new page.
- If a dependent page breaks, fix it or revert the component change. Do not leave a known
  regression.

Record the dependent pages and what was checked.

## 5. Duplicate information

Scan the rendered page for the same fact repeated in different regions, labels, or formats.

- Headline and summary saying the same thing.
- A status badge repeated in the header, body, and footer.
- A count shown as a metric, a chart label, and a table total with no distinct purpose.
- A derived value duplicated instead of referencing the source.
- An empty state that repeats the page title and the action label.

Remove or consolidate. If the duplication is intentional (for example, a sticky summary), state
why.

## 6. Spacing audit

Compare the rendered page to `DESIGN.md` `## Layout` and the spacing tokens.

- Padding, margins, and gaps use the approved scale.
- No arbitrary values such as `5px`, `10px`, `15px`, or one-off rem values.
- Component padding matches the documented size convention.
- Section spacing follows the responsive rhythm.
- Container widths and gutters match the documented convention.
- Alignment is consistent across repeated rows, cards, and form fields.
- No collapsed or doubled margins that break the rhythm.
- No layout shift when loading, error, or long content appears.

If a needed value is missing, add a token through Step 5; do not hardcode.

## 7. Visual glitches

Check with human eyes, not only assertions:

- clipping, truncation without affordance, or text overflow;
- overlapping elements, labels, or sticky regions;
- horizontal scroll at 390px and 1440px;
- misaligned columns, baselines, or action groups;
- empty containers or orphan dividers;
- inconsistent border radii, icon sizes, or control heights;
- focus rings clipped by overflow;
- scroll traps in modals or drawers;
- layout shift after data loads;
- dark-mode or high-contrast failures when supported.

Capture screenshots for each viewport and state that matters.

## 8. Accessibility and interaction

- Keyboard order follows the visual and task order.
- Every interactive element is reachable and has a visible focus state.
- Inputs have labels; errors are associated and announced.
- Buttons and links have accessible names.
- Color is not the only carrier of state.
- Contrast passes WCAG AA for text and UI; `DESIGN.md` lint catches token-level contrast.
- Reduced motion is respected for non-essential motion.
- Modal and drawer focus is trapped and restored.
- Disabled states are not used to hide a required explanation.
- Console has no errors; network has no failed requests that affect the page.

## 9. Evidence file

Write `.design/ux/<slug>/validation.md`:

```md
# Validation

- Page:
- Commit/branch:
- Command:
- Base URL:
- Playwright source: project | OMP browser | other
- Viewports: 1440×900, 390×844
- Journeys exercised:
- States exercised:
- Dependent pages:
- Screenshots:
- Console/network:
- Findings:
- Not run / blocked:
- Verdict: pass | fail | partial
```

A `pass` requires the primary journey and the relevant failure states to have been exercised. If
only the happy path was checked, the verdict is `partial`.

## 10. Stop conditions

Do not hand off as complete when:

- the app could not be served and no equivalent browser evidence exists;
- a changed component has unchecked dependent pages;
- a known duplicate or spacing violation remains;
- an error, loading, or empty state is broken;
- a console error or failed request affects the page;
- the only evidence is a static screenshot or a code inspection.

Report the gap, the attempted command, and the exact blocker. Never invent a passing result.
