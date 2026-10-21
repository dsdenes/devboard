/**
 * Stream helpers, matching what msgpack-javascript accepts.
 *
 * An application may pass either an async iterable of chunks or a WHATWG
 * ReadableStream. Older browsers expose ReadableStream without
 * Symbol.asyncIterator, so such a stream is adapted through its reader.
 */
export type ReadableStreamLike<T> = AsyncIterable<T> | ReadableStream<T>;

export function isAsyncIterable<T>(object: ReadableStreamLike<T>): object is AsyncIterable<T> {
  if (!(Symbol.asyncIterator in object)) {
    return false;
  }
  return typeof object[Symbol.asyncIterator] === "function";
}

export async function* asyncIterableFromStream<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function ensureAsyncIterable<T>(streamLike: ReadableStreamLike<T>): AsyncIterable<T> {
  return isAsyncIterable(streamLike) ? streamLike : asyncIterableFromStream(streamLike);
}
