---
name: single-responsibility-principle
description: State the single-responsibility policy that every unit of code has one cohesive purpose and one reason to change, and apply it when deciding where behavior belongs during design, implementation, review, or refactoring.
---

# Single Responsibility Principle

## Architectural Constraint

Every function, class, and module must have a single, clearly defined, cohesive responsibility.

A responsibility represents a distinct purpose or concern within the software. A component should have one primary reason to change, driven by the evolution of that responsibility.

## Design Principles

- **Focused responsibility:** Each component must serve one identifiable purpose. Its behavior should contribute directly to that purpose.
- **Cohesive behavior:** Functionality grouped within a component must be logically related and collectively serve its responsibility.
- **Separation of unrelated concerns:** Independent responsibilities must not be combined within the same component.
- **Single reason to change:** A component should change because its own responsibility evolves, not because of unrelated requirements.
- **Appropriate granularity:** Responsibilities must be defined at a meaningful level of abstraction. A single responsibility may legitimately involve multiple operations or behaviors.

## Architectural Violations

- **Mixed responsibilities:** A function, class, or module performs operations belonging to conceptually unrelated concerns.
- **Divergent change:** A component requires modifications for multiple independent reasons.
- **Accidental aggregation:** Unrelated functionality is grouped together for convenience rather than shared responsibility.
- **Responsibility leakage:** A component implements behavior that belongs to another component's responsibility.
- **Artificial fragmentation:** A cohesive responsibility is unnecessarily split into trivial components without establishing meaningful separation.

## Fundamental Constraint

**A component should have one clearly articulable purpose, and everything within it should contribute to fulfilling that purpose.**

Single Responsibility does not imply that a component must perform only one operation. It means that all its operations belong to the same cohesive responsibility.
