---
name: benchmark-methodology
description: State how to design and run performance measurements that isolate the operation under test, hold inputs and conditions constant, and report a distribution with uncertainty instead of a single number.
metadata:
  devboard-managed: "true"
---

# Benchmark Methodology

- Measure only the operation under test; build inputs, allocate buffers, and warm up the runtime
  outside the timed region.
- Use identical input data, options, and environment for every implementation compared, and pin
  the version of each.
- Run enough warmup and enough iterations that startup, interpretation, and compilation effects
  are excluded from the measured steady state.
- Consume every measured result so the optimizer cannot delete the work being timed; never time a
  call whose result is unused.
- Report a distribution with a central estimate, a measure of spread, and the sample count; add a
  confidence interval when comparing variants.
- Interleave or randomize the order of compared variants to cancel drift from thermal,
  scheduling, and cache effects.
- Cover the workload sizes and shapes real callers use, from small inputs to moderately large
  ones, plus every boundary where the implementation changes strategy.
- Separate throughput from latency questions, and report per-operation cost alongside bytes or
  elements processed.
- Keep benchmark identity and input sets stable across runs so results remain comparable over
  time; introduce a new benchmark rather than silently redefining an existing one.
- Re-run any performance claim from a clean process and repeat it before accepting the result.
