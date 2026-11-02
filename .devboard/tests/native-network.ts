/**
 * The native runtime globals, captured while the test process still has them.
 * A DOM test that registers happy-dom replaces `Response`, `Request`,
 * `Headers`, `fetch`, `AbortSignal`, the timers, and `location`; Bun's own
 * `fetch` and `Bun.serve` only accept the native objects, and a test that
 * installs its own `location` silently keeps happy-dom's non-writable one.
 *
 * The test worker keeps one global object across files, so every test starts
 * from the captured runtime while the DOM globals happy-dom installs stay in
 * place.
 */

export interface NativeNetwork {
  Response: typeof Response;
  Request: typeof Request;
  Headers: typeof Headers;
  fetch: typeof fetch;
  AbortController: typeof AbortController;
  AbortSignal: typeof AbortSignal;
  FormData: typeof FormData;
  Blob: typeof Blob;
  File: typeof File;
  DOMException: typeof DOMException;
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  Event: typeof Event;
  EventTarget: typeof EventTarget;
  MessageEvent: typeof MessageEvent;
  WebSocket: typeof WebSocket;
  crypto: typeof crypto;
  performance: typeof performance;
  structuredClone: typeof structuredClone;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  queueMicrotask: typeof queueMicrotask;
  requestAnimationFrame: typeof requestAnimationFrame;
  cancelAnimationFrame: typeof cancelAnimationFrame;
  MessageChannel: typeof MessageChannel;
  MessagePort: typeof MessagePort;
  BroadcastChannel: typeof BroadcastChannel;
}

const captured: NativeNetwork = {
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  fetch: globalThis.fetch,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
  File: globalThis.File,
  DOMException: globalThis.DOMException,
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  Event: globalThis.Event,
  EventTarget: globalThis.EventTarget,
  MessageEvent: globalThis.MessageEvent,
  WebSocket: globalThis.WebSocket,
  crypto: globalThis.crypto,
  performance: globalThis.performance,
  structuredClone: globalThis.structuredClone,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  queueMicrotask: globalThis.queueMicrotask,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  MessageChannel: globalThis.MessageChannel,
  MessagePort: globalThis.MessagePort,
  BroadcastChannel: globalThis.BroadcastChannel,
};

/**
 * Restores the captured runtime and gives the installed `location` the
 * writable data property a browser's global exposes, so a test can point it at
 * its own server.
 */
export function restoreNativeRuntime(): void {
  Object.assign(globalThis, captured);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  if (descriptor !== undefined && descriptor.writable !== true) {
    Object.defineProperty(globalThis, "location", {
      value: globalThis.location,
      writable: true,
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
    });
  }
}

export default captured;
