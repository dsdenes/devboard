/** How long a confirmed save stays visible. */
const VISIBLE_MS = 3000;

/**
 * One confirmation for the last persisted save. A store calls `saved` only
 * after the server confirms the write, so the message never claims a save the
 * server refused. The scope names the Save control that caused it, so only the
 * confirmation mounted beside that control renders the message. Each new
 * confirmation replaces the previous one, and it dismisses itself so a save
 * never needs a manual close.
 */
export class SaveFeedbackStore {
  text = $state<string | null>(null);
  /** The Save control's scope; only its confirmation renders. */
  scope = $state<string | null>(null);
  /** Invalidates the dismissal scheduled by an earlier confirmation. */
  private generation = 0;

  constructor(private readonly visibleMs: number = VISIBLE_MS) {}

  saved(scope: string, text: string): void {
    this.generation += 1;
    const generation = this.generation;
    this.scope = scope;
    this.text = text;
    setTimeout(() => {
      if (this.generation !== generation) return;
      this.scope = null;
      this.text = null;
    }, this.visibleMs);
  }

  dismiss(): void {
    this.generation += 1;
    this.scope = null;
    this.text = null;
  }
}

export const saveFeedback = new SaveFeedbackStore();
