# Run and interview state persistence

- Status: Accepted

## Context

The interface tracks an active run: the record being worked on, accumulated activity, the current question and choices, the developer's answers, and the stop state. It refuses a second run or a different record selection while a run is active, and allows the next record after a run stops. Whether this state persists, where, and in what format determines the state model and lifecycle.

The choice must support:

- preserving enough state to prevent concurrent runs and keep the displayed record, log, and question consistent;
- recording answers and the stop so the interface can continue from where it is and allow the next record afterwards;
- working with the runtime in `0001-interface-runtime-and-language.md` and the status source in `0005-adr-status-source-of-truth.md`;
- introducing no storage mechanism beyond the persistence chosen here.

## Decision

Active-run state lives in the backend process's memory for its lifetime: the record being worked on, the activity log, the current question, the answers, and the stop state. Restarting the backend ends the run. No other storage mechanism is introduced.
