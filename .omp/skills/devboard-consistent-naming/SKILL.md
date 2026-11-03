---
name: devboard-consistent-naming
description: State the consistent-naming policy that every domain concept has one clearly defined name used consistently throughout the relevant architectural context, and apply it when naming or renaming anything in the model, code, tests, interfaces, or documentation.
metadata:
  devboard-builtin: "true"
---

# Consistent Naming

Naming is a property of the conceptual model, not merely readability or style.

## Architectural Constraint

Every domain concept has one clearly defined name used consistently throughout the relevant
architectural context.

A concept is a thing the domain talks about: an entity, a value, an event, a rule, a role, or an
actor. Its name belongs to the model, not to the place it is written. The same concept carries the
same name in code, tests, interfaces, documentation, and conversation; two names for one concept
are a defect, and one name for two concepts is a defect.

## Design Principles

- **Consistent terminology:** Use one term for one concept everywhere it appears, and never
  alternate between synonyms for the same thing.
- **Ubiquitous language:** Name concepts in the domain's own vocabulary, so domain experts,
  documentation, and code speak the same words.
- **Semantic precision:** Choose the name that states exactly what the concept is and excludes what
  it is not; avoid vague, generic, or overloaded words.
- **Conceptual uniqueness:** Give each concept exactly one name, and each name exactly one concept,
  within its bounded context.
- **Contextual consistency:** Respect the bounded-context boundary: a word may name different
  concepts in different contexts, and inside one context its use must be consistent.
- **Vocabulary stability:** Keep an established name stable; rename only when the concept itself
  changes, and then rename every occurrence in one change.
- **Meaningful abstraction:** Name the concept at its own level of abstraction, meaning the domain
  concept, never its current implementation, storage, transport, or framework artifact.

## Architectural Violations

- **Synonymous naming:** The same concept appears under two or more names, so a reader must learn
  that the names denote one thing.
- **Semantic ambiguity:** One name denotes more than one concept, or its meaning depends on where
  it is read.
- **Inconsistent vocabulary:** The same concept is named differently across layers, modules, tests,
  or documentation.
- **Misleading naming:** A name suggests a meaning the concept does not have, such as behavior,
  ownership, or a scope it lacks.
- **Unnecessary terminology:** A new term is introduced for a concept that already has a name,
  adding vocabulary without adding meaning.
- **Conceptual collision:** Two distinct concepts share one name within a context, so the name no
  longer identifies either of them.
- **Implementation-driven naming:** A concept is named after its current implementation detail (a
  table, a transport, a framework type, or an algorithm) instead of after the domain concept.

## UbiLang Glossary Authority

Where the project publishes UbiLang glossaries at
`.omp/discover/glossary/<bounded-context>.glossary.yaml`, that glossary is the authoritative
vocabulary of its bounded context. A concept's preferred label (`prefLabels`) is the name its
bounded context uses; use it in code, tests, interfaces, and documentation.

A word that appears in more than one bounded context is governed by the glossary of the context the
name is used in. Another context's preferred label never overrides the local one and never licenses
a second name inside this context.

A name that conflicts with a published glossary (a synonym, a different spelling, or a term the
glossary assigns to another concept) is reported to the user with the concept id, the glossary's
preferred label, and the name in use. Never resolve such a conflict by introducing a new synonym,
and never silently rename a concept the glossary defines.

The authority rule applies only where the project has published glossaries. With none published,
this policy governs naming on its own, and the domain's own established names are the reference.

This skill neither creates nor edits glossary files. Discover owns `.omp/discover/glossary/**`, its
format, and its published content.

## Fundamental Constraint

**One concept, one name, one meaning — within a defined domain context.**

Naming is a property of the conceptual model, not merely readability or style. A name that drifts
from the model is a defect in how the model is expressed, even while the code still runs.
