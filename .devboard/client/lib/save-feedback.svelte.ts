/** How long a confirmed save stays visible. */
const VISIBLE_MS = 3000;

/**
 * One app-wide confirmation for the last persisted save. A store calls
 * `saved` only after the server confirms the write, so the toast never claims
 * a save the server refused. Each new confirmation replaces the previous one,
 * and the toast dismisses itself so a save never needs a manual close.
 */
export class SaveFeedbackStore {
  text = $state<string | null>(null);
  /** Invalidates the dismissal scheduled by an earlier confirmation. */
  private generation = 0;

  constructor(private readonly visibleMs: number = VISIBLE_MS) {}

  saved(text: string): void {
    this.generation += 1;
    const generation = this.generation;
    this.text = text;
    setTimeout(() => {
      if (this.generation !== generation) return;
      this.text = null;
    }, this.visibleMs);
  }

  dismiss(): void {
    this.generation += 1;
    this.text = null;
  }
}

export const saveFeedback = new SaveFeedbackStore();
