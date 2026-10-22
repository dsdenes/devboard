---
name: differential-conformance-testing
description: State how to prove behavioral equivalence against a reference implementation by pairing inputs, comparing observable results exactly, and retaining every discrepancy as a regression case.
metadata:
  devboard-managed: "true"
---

# Differential Conformance Testing

- Use the specification as the authority for format correctness and the reference implementation as
  the oracle for the compatibility contract; surface every divergence between them and decide it
  explicitly before encoding the decision in a test.
- Feed the same input, options, and sequence of operations to both implementations within one test
  run, and compare their observable results.
- Compare exactly: byte-for-byte for encoded output, structural equality including value types for
  decoded output, and error category plus failure point for rejected input.
- Cover every operation, option, format family, boundary, and documented error case with at least
  one paired case.
- Generate inputs across value types, every length boundary, nesting depth, and malformed or
  truncated data; shrink any failure to a minimal reproducing input.
- Retain every discovered discrepancy as a permanent regression case with its input and expected
  classification.
- Assert only on the public result; never assert on internal calls, private structure, or
  implementation-specific intermediate values.
- Run the same comparison suite under every supported runtime and environment; a difference there
  is a failure, not a platform note.
- Pin the reference version and record it with every result so a comparison can be reproduced.
- Treat an unavailable or skipped comparison as a failed check, never as a pass.
