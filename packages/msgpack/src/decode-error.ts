/**
 * Error raised when a decoded value violates a decoder policy, such as a
 * configured maximum length or a map key converter rejecting a key.
 * Matches the reference library's error category.
 */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, DecodeError.prototype);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: DecodeError.name,
    });
  }
}
