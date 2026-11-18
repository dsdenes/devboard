# Dependency graph widget — superseded

- Date: 2026-11-18. Issue: #2177. Type: documentation correction; no client or server source
  changed.
- Superseded by commit `2ee5ffb6` (*feat(discover): unify the data sheet into widget cards and drop
  the dependency graph*): it removed `MermaidDiagram.svelte`, `client/lib/dependency-diagram.ts`
  and its tests, the `dependencyChart` builder and its `diagramMode` rule, the
  `.discover-diagram__canvas` styles, and the `verify-interface` diagram checks, and
  `DiscoverOverview.svelte` no longer reads `architecture.dependencies`, so no Discover card draws
  recorded edges.
- Removed with this correction: the present-tense specification this packet carried (`brief.md`,
  `content-inventory.md`, `significance.md`, `structure.md`, `component-requirements.md`), its nine
  captures, `.design/a2ui/discover-dependency-graph.{a2ui.jsonl,wireframe.html}`, and the research
  receipt `.design/research/2026-10-29-discover-dependency-graph.md`. No widget remains to
  describe, wire, or verify, so the corpus keeps no superseded artifact for it.
- `DESIGN.md` no longer lists the component. `.design/ux/discover-bounded-contexts/` documents the
  shipped `Bounded contexts` card — the context list and the boundary role rows — which draws no
  edges.
- Checks: none applies. The change edits documentation only; no source, verifier, A2UI, token, or
  capture artifact for this packet remains to build, typecheck, or test.
