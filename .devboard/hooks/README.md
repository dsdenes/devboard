# Hooks

`devboard hooks install` installs the checked-in `pre-push` gate into this
checkout's shared hooks directory (`git rev-parse --git-common-dir`/hooks), so
every worktree is gated without a per-worktree step.

It is idempotent: an already-current hook is left alone. A differing hook is
refused unless `--force` is passed. The command refuses any harness that is not
the source checkout's `<checkout>/.devboard`, so an installed prefix never
receives this repository's gate.

The installed hook runs `devboard gate-prepush`, preferring the checkout's
release then debug binary and falling back to `devboard` on `PATH`. The gate
reads the ref lines from standard input and rejects only the commits the push
makes reachable that no remote already has.
