const MIN_WIDTH = 1024;
const MIN_HEIGHT = 720;

class ViewportStore {
  width = $state(0);
  height = $state(0);

  get supported(): boolean {
    return this.width >= MIN_WIDTH && this.height >= MIN_HEIGHT;
  }

  update(): void {
    if (typeof window === "undefined") return;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
  }
}

export const viewport = new ViewportStore();
export const MINIMUM_VIEWPORT = { width: MIN_WIDTH, height: MIN_HEIGHT };
