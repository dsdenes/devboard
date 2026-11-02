# A2UI wireframe reference

Step 3 produces an A2UI definition and a standalone wireframe. They describe information
structure. They do not choose production components or visual design.

## Version

Use A2UI v0.9.1 unless the project pins another supported version in
`.design/a2ui/config.json` or `.design/a2ui/version`.

```json
{
  "version": "0.9.1",
  "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"
}
```

v1.0 is supported only when the project explicitly pins it. Do not mix message versions in one
file.

`catalogId` is an opaque identifier agreed with the renderer, not a version URL that must resolve.
Use the ID declared by the catalog your renderer actually loads. The official basic catalog bundled
with the A2UI repo declares `.../v0_9/catalogs/basic/catalog.json`; use that declared value when
you use that catalog.

## Message stream

A2UI is a stream of JSON objects. A static definition can be stored as JSONL, one message per
line, in this order:

1. `createSurface`
2. `updateComponents`
3. `updateDataModel`

```jsonl
{"version":"v0.9.1","createSurface":{"surfaceId":"settings-billing","catalogId":"https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json","sendDataModel":false}}
{"version":"v0.9.1","updateComponents":{"surfaceId":"settings-billing","components":[{"id":"root","component":"Column","children":["header","plan","invoice"]},{"id":"header","component":"Text","text":"Billing","variant":"h1"},{"id":"plan","component":"Card","children":["plan_title","plan_action"]},{"id":"plan_title","component":"Text","text":"Current plan: Team"},{"id":"plan_action","component":"Button","text":"Change plan"},{"id":"invoice","component":"Text","text":"Next invoice: 12 Nov 2026"}]}}
{"version":"v0.9.1","updateDataModel":{"surfaceId":"settings-billing","path":"/","value":{}}}
```

Rules:

- One `root` component per surface.
- Component IDs are unique within the surface.
- Children are IDs, not nested objects.
- Use literal values for the wireframe; use data bindings only when the structure depends on a
  collection.
- A surface may be updated with more `updateComponents` or `updateDataModel` messages for states.
- Do not put production data or secrets in the file. Use representative sample data.

## Allowed components

Use only the A2UI basic catalog for the pinned version. The list below is the v0.9.1 basic catalog;
for v1.0, use the v1.0 catalog and still do not invent components.

`AudioPlayer`, `Button`, `Card`, `CheckBox`, `ChoicePicker`, `Column`, `DateTimeInput`, `Divider`,
`Icon`, `Image`, `List`, `Modal`, `Row`, `Slider`, `Tabs`, `Text`, `TextField`, `Video`.

These are wireframe vocabulary, not a decision to use a production `Button` or `Card` in Step 4.
If a structural need does not map to a catalog component, compose `Column`, `Row`, `Card`, `Text`,
and `Divider`. Do not invent `Page`, `Section`, `Hero`, or `Grid` component types. Encode the
region name in the component `id` (for example `region_header`, `region_primary_action`).

## Structure for the wireframe

Write `.design/ux/<slug>/structure.md` with:

- **Regions and order:** top to bottom, left to right, with A2UI IDs.
- **Journey mapping:** which Step 0 journey each region serves.
- **Significance mapping:** P0/P1/P2/P3 items and where they land.
- **Primary action:** exactly one per screen or critical state.
- **State coverage:** loading, empty, error, partial, permission-denied, success.
- **Responsive order:** what collapses, moves, or hides at narrow widths.
- **Rationale:** why this grouping beats the obvious alternatives.

The structure must satisfy:

- P0 is visible without scrolling on the target viewport, or is the only critical-path action.
- P1 is in the main flow or one interaction away.
- P2 is behind disclosure; P3 is absent unless justified.
- No duplicate information in two regions.
- No container that exists only to hold another container.
- Failure and recovery routes are representable, not just the happy path.
- The mobile order preserves the primary task.

## Standalone HTML wireframe

Write `.design/a2ui/<slug>.wireframe.html` as a self-contained file.

Requirements:

- Inline CSS only. No external stylesheet, font, icon set, image, or script.
- No imports from the production app, Storybook, or the design system.
- No production CSS variables, brand colors, brand fonts, shadows, gradients, or illustrations.
- Neutral palette: white/off-white background, gray borders, dark gray text, one muted accent for
  annotations only.
- System font stack. Use size and weight only to show hierarchy, not brand typography.
- Boxes and labels for regions; placeholder lines for text; simple blocks for actions.
- Each major region carries a small annotation with its A2UI ID and priority (`P0`, `P1`, `P2`).
- Use semantic landmarks (`header`, `main`, `section`, `nav`, `footer`) and real heading levels.
- One responsive breakpoint, for example `@media (max-width: 768px)`.
- No horizontal scroll at 390px and 1440px.
- It must be obvious that this is a wireframe, not a finished visual design.

The HTML does not need to implement A2UI interactivity. It must render the same structure and
content order as the A2UI stream.

## State wireframes

The primary file may show the default state. When a state changes the structure materially, add a
separate file:

```text
.design/a2ui/<slug>.empty.a2ui.jsonl
.design/a2ui/<slug>.empty.wireframe.html
.design/a2ui/<slug>.error.a2ui.jsonl
.design/a2ui/<slug>.error.wireframe.html
```

Do not create a file for a state that only changes a label or a color. Step 6 validates those in
the real UI.

## Verification

- Open the wireframe in a browser or screenshot it with Playwright.
- Confirm the structure matches the A2UI stream.
- Confirm 390px and 1440px have no overflow and preserve the primary action.
- Confirm the wireframe contains no production component or brand asset.
- Confirm every P0/P1 item from Step 2 appears exactly once.

If the wireframe cannot be rendered, Step 3 is not done.
