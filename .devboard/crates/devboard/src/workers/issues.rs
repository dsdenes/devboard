//! Issues worker engine: one detached run owns the issue sync and filing.

use super::WorkerInvocation;

/// Runs one cycle of this family's engine.
pub async fn run(invocation: &WorkerInvocation) -> anyhow::Result<()> {
    crate::issues_mode::run_worker(&invocation.raw).await
}
