---
name: drop-in-compatibility
description: State the rules for replacing an existing library with a compatible implementation so that callers change no code and observe no behavioral difference, while every intentional divergence is versioned and documented.
metadata:
  devboard-managed: "true"
---

# Drop-In Compatibility

- Define the compatibility surface as every documented and de-facto observable behavior: entry
  points, option names and defaults, accepted input types, return types, thrown errors, and the
  order and timing of observable side effects.
- Preserve the original's behavior for every accepted option and option combination; new behavior
  must be additive and opt-in.
- Match failure behavior exactly: the same conditions fail, with the same error category and the
  same partial-output semantics. Never turn a supported input into a failure or a failure into
  silent success.
- Match default output choices, including which representation is selected when several are valid.
- Keep semantics identical across every supported environment; never gate behavior on the host
  environment or platform.
- Treat every observable difference as a compatibility defect, even when it looks like an
  improvement, until callers can consume it as an addition rather than a change.
- Expose the replacement through the same public entry point and distribution surface, so callers
  change no import, configuration, or initialization step.
- Record the compatibility baseline: the exact reference version and the behavior contract derived
  from it, including cases the reference handles inconsistently.
- Version the public surface with Semantic Versioning; backward-compatible additions take a minor
  release, and any behavior change a caller can observe takes a major release.
- Retire a compatibility path only after an explicit deprecation period and a documented migration
  path.
