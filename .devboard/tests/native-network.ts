/**
 * The native network constructors, captured while the test process still has
 * them. A DOM test that registers happy-dom replaces `Response`, `Request`,
 * `Headers`, and `fetch`; Bun's own `fetch` and `Bun.serve` only accept the
 * native `Response`, so a test file that serves or downloads bytes restores
 * these before it runs and puts the replaced globals back afterwards.
 */

export interface NativeNetwork {
  Response: typeof Response;
  Request: typeof Request;
  Headers: typeof Headers;
  fetch: typeof fetch;
  AbortController: typeof AbortController;
  AbortSignal: typeof AbortSignal;
}

const captured: NativeNetwork = {
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  fetch: globalThis.fetch,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};

export default captured;
