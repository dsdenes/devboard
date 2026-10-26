# Bounded contexts widget — brief

Scope: the `Bounded contexts` card of Discover → Overview, rendered from
`sheet.architecture`. This is one card inside an existing page, not a new page; the page-level
brief lives in `.design/ux/discover/brief.md` and still applies.

## Page identity

- Route: the Discover mode of the devboard interface, Overview sub-tab; the card is the sixth
  region of that page.
- Title: `Bounded contexts`.
- Auth/role: none beyond access to the local dashboard.
- Entry points: opens with the published sheet when `architecture` is present; reachable from the
  mode rail (`Discover`) and the sidebar (`Overview`), and from a mode switch away from Goal or
  Flow.

## Primary goal

Let the developer answer "where does this change live, and what may it depend on?" from the
crawled project sheet. Observable success: the reader names the owning context and its repository
path, and can state whether the code sits inside a context, in shared kernel code, or across an
external boundary, without leaving the card.

## Secondary goals

- Establish the allowed dependency direction so a change that points the wrong way is visible.
- Connect the context vocabulary to the glossary, which is grouped by the same bounded contexts.

These support the primary goal; they never displace the context list.

## Arrival context

- The reader has just crawled the project or reopens a published sheet and is scanning for
  orientation.
- They know the repository, not necessarily the crawler's vocabulary; "bounded context", "shared
  kernel", and "external boundary" are DDD terms the sheet uses deliberately.
- They may arrive with a glossary term in mind (journey 5 of the page brief) and need the owning
  code area, or with a change in mind and need the allowed dependency direction.
- Desktop only: the shell requires at least 1024×720; there is no mobile layout.
- Partial data is normal: the crawl may not observe sources, may find no boundary, or may infer the
  direction instead of observing it.

## Relationship to other pages

- Upstream: the Discover run and its published `sheet.json`.
- Downstream: the Glossary page, whose context cards carry the same context names; the
  `discover-architecture-boundaries` skill, which states the policy derived from this state.
- Loop: a re-discovery replaces the whole sheet; a stop, failure, or interrupt leaves the previous
  card readable.
- State left behind: none; the card is read-only.

## User journeys

### Journey 1 — Find the code that owns a change

Trigger: the reader needs to place a change in the project.

1. Scan the context list for the business area named in the requirement.
2. Read the context's responsibility to confirm the match.
3. Read the path and the entry points to know where to open the code.
4. Success: one context owns the change and its paths are known.
5. Failure: no context matches. The card states that no context was detected or that the crawl did
   not observe the section; the reader falls back to the repository itself.
6. Recovery: re-discover after adding or clarifying source, or use the glossary term's usage data.
7. Exit: open the code, or move to the glossary for vocabulary.

### Journey 2 — Judge coupling before changing a boundary

Trigger: the change crosses code owned by more than one area or touches an external system.

1. Find the owning context.
2. Check shared kernels: code that more than one context may import.
3. Check external boundaries: systems outside the domain that the change must talk to.
4. Read the dependency direction to know which way an import may point.
5. Success: the reader knows whether the change belongs in a context, a shared kernel, or an
   adapter to an external system.
6. Failure: a boundary group was not observed. The card states which group and why, rather than
   implying that no such code exists.
7. Recovery: re-discover; inspect the repository for the named group.
8. Exit: proceed, or raise the coupling with the team.

### Journey 3 — Re-crawl and compare

Trigger: code changed and the reader re-runs discovery.

1. Re-open Overview after the run publishes.
2. Re-read the context list and boundary groups against the previous state.
3. Success: the new architecture is reflected; confirmed glossary decisions elsewhere are intact.
4. Failure: the run fails or is interrupted; the previous card remains, and the page-level notice
   states that nothing was published.
5. Recovery: rerun discovery.
6. Exit: continue with the current sheet.

### Journey 4 — Read a partial sheet

Trigger: the crawl could not observe source code, or observed only some boundary fields.

1. Open the card.
2. The contexts or a boundary group is marked unknown with a reason.
3. Success: the reader knows what is missing and does not treat absence as evidence of absence.
4. Failure: repeated or contradictory explanations obscure the rest; the card must state each
   missing group once.
5. Exit: rely on the observed groups only.

## Non-goals

- Editing contexts, boundaries, or dependencies. Only the glossary decisions and the five skills
  are editable in Discover.
- Drawing dependency edges between contexts; the sheet stores no edge list, and inventing one
  would misstate the crawl's evidence.
- Repeating glossary term lists, test strategy, or commands inside this card.
- Showing command, build, or CI facts; those have their own cards.
- Aggregating a project "architecture score" or metric.

## Assumptions

- `sheet.architecture` carries `contexts`, `dependencyDirection`, `externalBoundaries`, and
  `sharedKernels` exactly as the prompt schema defines them.
- Boundary values are free strings without per-context association, so grouping by role is the
  only honest visualization.
- The crawler sorts contexts and values canonically; the card preserves that order.
- A context's `path` and an `entryPoints` value may repeat; the card shows the path once.
