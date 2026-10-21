export const fixtures: unknown[] = [
  null,
  true,
  false,
  0,
  42,
  -1234,
  1234567890123,
  3.25,
  "hello, msgpack",
  "héllo wörld — 日本語 ✓ 😀",
  new Uint8Array([0, 1, 2, 3, 255]),
  [1, "two", true, null, [3, 4]],
  { id: 1, name: "widget", ok: true, tags: ["a", "b"], meta: { depth: 2 } },
  {
    users: [
      { id: 1, name: "Ada", active: true, score: 99.5 },
      { id: 2, name: "Grace", active: false, score: 87.25 },
    ],
    cursor: null,
    blob: new Uint8Array(300).map((_, index) => index & 0xff),
  },
];
