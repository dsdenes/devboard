export const DEFAULT_INITIAL_BUFFER_SIZE = 2048;

/**
 * Growable big-endian output buffer. The writer owns both byte and DataView
 * views of the same ArrayBuffer so callers can use whichever is faster for a
 * given field width.
 */
export class Writer {
  bytes: Uint8Array<ArrayBuffer>;
  view: DataView<ArrayBuffer>;
  pos = 0;

  constructor(size: number = DEFAULT_INITIAL_BUFFER_SIZE) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  reset(): void {
    this.pos = 0;
  }

  ensure(extra: number): void {
    const required = this.pos + extra;
    if (required > this.bytes.length) {
      this.grow(required);
    }
  }

  private grow(required: number): void {
    let capacity = this.bytes.length || DEFAULT_INITIAL_BUFFER_SIZE;
    const doubled = capacity * 2;
    // A single large value should cost one allocation, like the reference,
    // not one allocation per doubling step.
    capacity = doubled >= required ? doubled : required * 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  /** A copy that does not alias the writer's reusable buffer. */
  copy(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.pos);
  }

  /** A view into the writer's buffer, valid until the next reset/grow. */
  ref(): Uint8Array<ArrayBuffer> {
    return this.bytes.subarray(0, this.pos);
  }
}
