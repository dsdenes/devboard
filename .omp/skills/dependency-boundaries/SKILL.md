---
name: dependency-boundaries
description: State how to keep a runtime-neutral core independent of host-specific adapters so that behavior remains substitutable and environment details cannot leak into the contract.
metadata:
  devboard-managed: "true"
---

# Dependency Boundaries

- Place format, type-system, and policy logic in a runtime-neutral core; place environment-specific
  access behind adapters that depend on the core, never the reverse.
- Point every dependency toward the more stable, more abstract side; the core must not reference
  adapters, host globals, or platform conditionals.
- Define the smallest interface each adapter must satisfy, and state the preconditions and
  postconditions callers may rely on.
- Preserve substitutability: a replacement must accept every input the original accepts, satisfy
  the same postconditions, and preserve the same observable history for state and errors.
- Never strengthen a precondition, weaken a postcondition, or expose adapter-specific behavior
  through the public surface.
- Keep one implementation of each invariant; adapters translate inputs and outputs, they do not
  duplicate core rules.
- Isolate unsupported environment features behind capability checks with a defined fallback, and
  never let an environment assumption influence encoded output.
- Test the core without a host environment, and test each adapter against the same behavioral
  contract as the implementation it stands in for.
- Introduce an abstraction only when a second implementation or adapter exists or is required;
  otherwise keep the direct call.
