/**
 * UTF-8 byte budgets. Every size cap the harness reports to an agent or a peer
 * is a byte count, so truncation must measure and cut in bytes too. Slicing a
 * byte count with `String.slice` counts UTF-16 code units instead and
 * overshoots the cap by up to four times for non-ASCII text.
 */

export interface BoundedText {
  text: string;
  truncated: boolean;
}

/**
 * The longest prefix of `buffer` no longer than `budget` bytes that ends on a
 * code point boundary, so decoding never emits a replacement character.
 */
function prefix(buffer: Buffer, budget: number): string {
  if (budget <= 0) return "";
  if (buffer.length <= budget) return buffer.toString("utf8");
  let end = budget;
  let lead = end - 1;
  while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  const byte = buffer[lead]!;
  const width = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  if (lead + width > budget) end = lead;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes, appending `marker` when
 * it cuts. Trailing whitespace is dropped before the marker. The result never
 * exceeds the budget, even when the marker alone would.
 */
export function boundBytes(text: string, maxBytes: number, marker = "..."): BoundedText {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes < markerBytes) {
    return { text: prefix(Buffer.from(marker, "utf8"), maxBytes), truncated: true };
  }
  const body = prefix(buffer, maxBytes - markerBytes).trimEnd();
  return { text: `${body}${marker}`, truncated: true };
}