/**
 * One command control's in-flight state.
 *
 * A control that dispatches a WebSocket command shows the present-participle
 * busy word of its own verb until the server confirms the command. Evidence is
 * the store value the confirming frame changes: `start()` captures it, and the
 * control leaves busy the moment the value differs. A value that never arrives
 * within the ceiling releases the label and surfaces a `role="status"` notice.
 *
 * Evidence must be a primitive or a stable reference that does not return to
 * its pre-command value; a snapshot field or an object identity is right, a
 * freshly allocated array is not.
 */

/** Longest a control waits for a confirming frame before releasing its label. */
export const COMMAND_CEILING_MS = 10_000;

/**
 * Participles that a mechanical `-ing` rule would get wrong. The mechanical
 * rule handles every other verb this interface uses, including a phrase label
 * such as "Discover project", which becomes "Discovering…".
 */
const PARTICIPLES: Record<string, string> = {
  cancel: "cancelling",
  commit: "committing",
  plan: "planning",
  reset: "resetting",
  stop: "stopping",
  submit: "submitting",
};

/** `Start` → `Starting…`, `Stop` → `Stopping…`, `Discover project` → `Discovering…`. */
export function busyWord(label: string): string {
  const verb = label.trim().split(/\s+/)[0] ?? "";
  if (verb.length === 0) return "";
  const lower = verb.toLowerCase();
  const base =
    PARTICIPLES[lower] ??
    (lower.endsWith("e") ? `${lower.slice(0, -1)}ing` : `${lower}ing`);
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}…`;
}

export interface CommandBusyOptions<E> {
  /** The resting visible label the busy word is derived from. */
  label: string | (() => string);
  /** Reactive read of the server state that confirms the command. */
  evidence: () => E;
  /**
   * Reactive read of the subject this control acts on. One component instance
   * can be reused for a different subject — the Start/Stop control is shared
   * by every agent page — and the previous subject's latch must not follow it.
   */
  scope?: () => unknown;
  /** Overrides the 10-second ceiling; tests use a short bound. */
  ceilingMs?: number;
}

export class CommandBusy<E> {
  #active = $state(false);
  #expired = $state(false);
  #dismissed = $state(false);
  /**
   * The evidence captured at activation. Reactive, so a second dispatch that
   * changes only the latch — the previous answer already released the label —
   * still re-renders the busy word; `raw` keeps an object evidence's identity.
   */
  #baseline: E | undefined = $state.raw(undefined);
  /** The subject captured at activation; a reused control has no claim on another. */
  #scopeBaseline: unknown = $state.raw(undefined);
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #label: () => string;
  readonly #evidence: () => E;
  readonly #scope: (() => unknown) | undefined;
  readonly #ceilingMs: number;

  constructor(options: CommandBusyOptions<E>) {
    this.#label =
      typeof options.label === "function" ? options.label : () => options.label as string;
    this.#evidence = options.evidence;
    this.#scope = options.scope;
    this.#ceilingMs = options.ceilingMs ?? COMMAND_CEILING_MS;
  }

  /** True from the activation until evidence, the ceiling, or a dismissal. */
  get busy(): boolean {
    return (
      this.#active &&
      !this.#expired &&
      !this.#dismissed &&
      this.#sameSubject() &&
      Object.is(this.#evidence(), this.#baseline)
    );
  }

  /** The present-participle busy word of the resting label. */
  get word(): string {
    return busyWord(this.#label());
  }

  /**
   * The visible ceiling notice: the action received no answer. It never
   * replaces another message; the control renders it beside itself.
   */
  get notice(): string | null {
    if (!this.#active || !this.#expired || this.#dismissed) return null;
    if (!this.#sameSubject()) return null;
    if (!Object.is(this.#evidence(), this.#baseline)) return null;
    const label = this.#label().trim();
    return label.length === 0
      ? "The action received no answer."
      : `${label} received no answer.`;
  }

  /** Begin a dispatch: latch the evidence baseline and arm the ceiling. */
  start(): void {
    this.#clearTimer();
    this.#baseline = this.#evidence();
    this.#scopeBaseline = this.#scope?.();
    this.#active = true;
    this.#expired = false;
    this.#dismissed = false;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#expired = true;
    }, this.#ceilingMs);
  }

  /** Clear the ceiling notice without sending anything. */
  dismiss(): void {
    this.#clearTimer();
    this.#active = false;
    this.#dismissed = true;
  }

  #sameSubject(): boolean {
    return this.#scope === undefined || Object.is(this.#scope(), this.#scopeBaseline);
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export function createCommandBusy<E>(options: CommandBusyOptions<E>): CommandBusy<E> {
  return new CommandBusy(options);
}
