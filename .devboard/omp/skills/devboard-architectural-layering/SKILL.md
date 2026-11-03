---
name: devboard-architectural-layering
description: State the architectural-layering policy that every concern belongs to a clearly defined architectural boundary, that dependencies follow the architecture's defined direction, and that infrastructure details never leak into business abstractions, and apply it when placing, reviewing, or refactoring behavior across boundaries.
metadata:
  devboard-builtin: "true"
---

# Architectural Layering

Architecture is the set of boundaries that decide where behavior belongs and which direction its
dependencies may run.

## Architectural Constraint

Every concern belongs to a clearly defined architectural boundary, and dependencies follow the
direction that architecture defines.

A concern is anything the software must do or know: presentation, application flow, domain rules,
persistence, transport, or integration. The boundary decides which concern owns a behavior and
which concerns may reference it. A behavior that belongs to the domain but lives in a transport
handler sits in the wrong boundary even while it works, and a dependency that points from the
domain toward a database, framework, or interface inverts the architecture's direction.

## Design Principles

- **Separation of concerns:** Each concern is implemented in its own boundary, and no boundary
  mixes unrelated responsibilities such as domain rules, orchestration, transport, and storage.
- **Explicit architectural boundaries:** Every boundary is named and visible in the code's
  structure and public surface, so a reader can state which boundary a module belongs to.
- **Consistent dependency direction:** Dependencies run only in the direction the architecture
  defines; a boundary depends on abstractions, never on the concrete details of a boundary that
  depends on it.
- **Business logic independence:** Domain rules are expressed without framework, transport,
  storage, or interface types, so they can be understood, tested, and reused on their own.
- **Encapsulation of technical concerns:** Frameworks, databases, queues, HTTP clients, and
  serialization stay inside the infrastructure boundary and never appear in business
  abstractions.
- **Controlled cross-layer interaction:** A boundary communicates through its defined interface;
  no caller reaches past an intermediate boundary into the internals of a deeper one.
- **Architectural consistency:** Every feature respects the same established boundaries and
  dependency direction, and a new feature is placed by that architecture rather than by local
  convenience.
- **Appropriate abstraction:** Each boundary exposes the abstraction its consumers need, neither
  leaking implementation detail nor adding layers that serve no concern.

## Architectural Violations

- **Mixed concerns:** One unit implements several unrelated concerns, such as parsing a request,
  deciding a domain rule, and writing a row in the same place.
- **Boundary violations:** Code in one boundary depends on or mutates the internals of another
  boundary it must not know about.
- **Dependency inversion violations:** A policy boundary depends on a concrete mechanism instead of
  an abstraction it owns, so infrastructure dictates the domain.
- **Infrastructure leakage:** A framework type, database row, transport object, or serialization
  detail appears in a business interface, domain model, or test of business rules.
- **Misplaced responsibilities:** A behavior lives in a boundary that does not own its concern,
  such as validation in a view or persistence orchestration in an entity.
- **Layer bypassing:** A caller skips an intermediate boundary and reaches directly into a deeper
  boundary's internals.
- **Circular architectural dependencies:** Two boundaries depend on each other, directly or through
  a chain, so neither can change or be understood independently.
- **Inconsistent layering:** The same kind of behavior is placed differently in different features,
  so the architecture exists only in documentation.
- **Artificial layering:** Blanket wrappers, pass-through layers, or interfaces with one
  implementation and no boundary concern are added in the name of layering.

## Architectural Boundaries

This policy is independent of a specific architectural style. It applies equally to traditional
layered architecture, Clean Architecture, Onion Architecture, and Hexagonal Architecture, and to a
project that names its boundaries differently.

Four conceptual responsibilities recur across those styles:

|Responsibility|Owns|
|---|---|
|`Interface / Presentation`|User or client interaction and the shape of input and output.|
|`Application`|Use-case orchestration, transactions, and coordination between the domain and the outside.|
|`Domain`|Business rules, entities, value objects, and invariants.|
|`Infrastructure`|Persistence, transport, messaging, frameworks, and external systems.|

These names describe the responsibilities the policy separates; they are not a mandatory
four-layer structure. A project may merge, split, rename, or omit them. The project's established
architecture determines the actual boundaries and dependency directions, and this policy holds
whatever that architecture defines.

## Fundamental Constraint

**Every concern belongs to a clearly defined architectural boundary, and every dependency respects
those boundaries.**

Layering is not about directory organization and not about adding abstractions. A new folder, a new
wrapper, or an interface with a single implementation adds no boundary. What matters is that each
concern has one owner and that every dependency runs in the direction the architecture defines.
