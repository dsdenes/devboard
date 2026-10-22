---
name: wire-format-conformance
description: State the rules for implementing and validating a documented binary interchange format so that encoded bytes and decoding behavior follow the authoritative specification exactly, including boundaries, limits, and malformed input.
metadata:
  devboard-managed: "true"
---

# Wire-Format Conformance

- Treat the authoritative specification as the sole source of truth for the type system, format
  families, tag values, byte order, length prefixes, and limits; resolve any disagreement in favor
  of the specification.
- Implement every format the specification defines for a value that can be encoded, including the
  exact lengths at which the implementation switches between formats.
- Encode with the smallest format that represents a value whenever the specification permits
  several, unless a documented compatibility contract fixes different bytes; a compatibility
  requirement overrides the size preference only when it is explicit and recorded.
- Keep encoding deterministic: the same value and the same options produce the same bytes on every
  run and every supported runtime.
- Preserve the specification's value ranges, signed and unsigned, and reject out-of-range values
  instead of truncating or coercing them silently, unless the compatibility contract defines a
  different behavior for that case.
- Define behavior for every malformed input the specification names, including truncation, unknown
  tags, impossible lengths, length overruns, and reserved values; never skip or guess bytes.
- Validate lengths, element counts, and remaining-byte budgets before allocating memory or looping
  over caller-supplied input.
- Honor reserved and application-defined identifier ranges; never reinterpret a reserved
  identifier as a defined one.
- Make encoding and decoding exact inverses for every valid value, including edge representations
  such as negative zero, NaN payloads, and empty aggregates.
- Emit no padding, field order, or alternative representation that the specification does not
  define.
- Maintain an executable conformance suite with at least one case per format family and per
  boundary value, and run it on every change.
